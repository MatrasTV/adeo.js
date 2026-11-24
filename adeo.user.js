// ==UserScript==
// @name         ADEO — прайсы и расписание поставщиков
// @namespace    admin.adeo.pro
// @version      3.7.0
// @description  Работа с прайсами и мастер расписания поставщиков CRM
// @author       MatrasTV
// @icon         https://github.com/MatrasTV.png?size=128
// @homepageURL  https://github.com/MatrasTV/adeo.js
// @source       https://github.com/MatrasTV/adeo.js.git
// @supportURL   https://github.com/MatrasTV/adeo.js/issues
// @downloadURL  https://github.com/MatrasTV/adeo.js/releases/latest/download/adeo.user.js
// @updateURL    https://github.com/MatrasTV/adeo.js/releases/latest/download/adeo.user.js
// @match        https://admin.adeo.pro/admin/admin_pricerelevance/list*
// @match        https://admin.adeo.pro/admin/supplier/price/compare/*
// @match        https://admin.adeo.pro/admin/supplier/price/comparemode/*
// @match        https://avatar.adeo.pro/istat.php*
// @match        https://crm.adeo.pro/*
// @run-at       document-start
// @sandbox      raw
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      crm.adeo.pro
// @connect      s3.adeo.pro
// ==/UserScript==

(function () {
    'use strict';

    const SROKI_URL = 'https://192.168.3.19:6001/sroki';
    const PRICE_RELEVANCE_PATH = '/admin/admin_pricerelevance/list';
    const TEST_PRICE_SUPPLIER = '43068';
    const TEST_PRICE_CELL_KEY = 'autoPriceTestCell';
    const CRM_MARKETABILITY_API = 'https://crm.adeo.pro/svc-platform-v1/graphql';
    const CRM_REPORT_ORIGIN = 'https://s3.adeo.pro';
    const CRM_REPORT_MAX_BYTES = 50 * 1024 * 1024;
    const AUTO_PRICE_CHECK_TITLE = 'Авто проверка прайса';
    const AUTO_PRICE_CHECK_PARAM = 'adeo-auto-price';
    const RELEVANCE_DEFAULTS = { outStart: '5', orders_avg_cost: false, orders_max_cost: false };
    const PAGE_SIZES = [10, 50, 100, 500, 1000, 3000, 5000, 10000, 100000];
    const initializedFields = new WeakSet();
    const filteredRowDisplays = new WeakMap();
    const supplierRowHeights = new WeakMap();
    const copyFeedback = new WeakMap();
    const priceDifferenceValues = new WeakMap();
    const loadingRequests = new Map();
    let hideReg = true;
    const relevanceProgress = { stage: 'idle', message: '', busy: false, percent: null,
        started: null, finished: null, warning: '', links: [], revision: 0, uploading: false, notify() {} };
    const relevanceAnalysis = { phase: 'idle', revision: 0, armed: false, accepted: false, token: 0,
        percent: null, message: '', result: null, started: null, finished: null, worker: null,
        controller: null, blob: null, blobUrl: '', fileName: '', source: '', timer: null, reportTask: null };
    let quickLinksInstalled = false;

    function parseQuickPriceReference(value) {
        if (typeof value !== 'string') return null;
        const text = value.trim();
        const pair = text.match(/^([1-9]\d*)\s*\/\s*([1-9]\d*)$/);
        if (pair) return { supplier: pair[1], file: pair[2] };
        try {
            const url = new URL(text, 'https://admin.adeo.pro');
            if (url.origin !== 'https://admin.adeo.pro') return null;
            const match = url.pathname.match(/^\/admin\/supplier\/price\/(?:compare|comparemode)\/([1-9]\d*)\/([1-9]\d*)\/?$/);
            return match ? { supplier: match[1], file: match[2] } : null;
        } catch { return null; }
    }

    function openQuickPricePage(mode) {
        // Адреса сравнения и загрузки зависят от поставщика; пример из документации не является значением по умолчанию.
        let reference = window.location.hostname === 'admin.adeo.pro' ? parseQuickPriceReference(window.location.pathname) : null;
        if (!reference) {
            const answer = window.prompt('Введите ID поставщика и номер прайса через /, например 43068/1. Также можно вставить ссылку на сравнение или загрузку прайса.', '');
            if (answer === null) return;
            reference = parseQuickPriceReference(answer);
            if (!reference) { window.alert('Не удалось определить прайс. Введите два положительных числа через /: ID поставщика/номер прайса.'); return; }
        }
        GM_openInTab(`https://admin.adeo.pro/admin/supplier/price/${mode}/${reference.supplier}/${reference.file}`, { active: true });
    }

    function installQuickLinksMenu() {
        if (quickLinksInstalled || typeof GM_registerMenuCommand !== 'function' || typeof GM_openInTab !== 'function') return;
        // Команды регистрируются один раз в основной вкладке, без дублирования из вложенных фреймов.
        if (window.top && window.top !== window.self) return;
        quickLinksInstalled = true;
        const links = [
            [AUTO_PRICE_CHECK_TITLE, `https://admin.adeo.pro${PRICE_RELEVANCE_PATH}?${AUTO_PRICE_CHECK_PARAM}=1`],
            ['Анализ прайса на продаваемость', `https://admin.adeo.pro${PRICE_RELEVANCE_PATH}`],
            ['Анализ конкурентоспособности прайса — CRM', 'https://crm.adeo.pro/reports/marketability'],
            ['Статистика импорта прайсов', 'https://avatar.adeo.pro/istat.php'],
            ['Поставщики и расписание — CRM', 'https://crm.adeo.pro/supplier/supplier-list']
        ];
        links.forEach(([title, url]) => GM_registerMenuCommand(title, () => GM_openInTab(url, { active: true })));
        GM_registerMenuCommand('Загрузка тестового прайса', () => openQuickPricePage('comparemode'));
    }

    // Следим за появлением элементов и обновлением текста без постоянного опроса.
    function observePage(update) {
        const observer = new MutationObserver(mutations => {
            // Тики таймера загрузки не должны повторно обходить всю таблицу.
            if (mutations.every(mutation => {
                const element = mutation.target.nodeType === 3 ? mutation.target.parentElement : mutation.target;
                return element?.closest?.('.adeo-loading, .adeo-relevance-bar');
            })) return;
            update();
        });
        const config = { childList: true, subtree: true, characterData: true };
        observer.observe(document.body, config);
        update();
        window.addEventListener('pagehide', () => observer.disconnect());
        window.addEventListener('pageshow', event => {
            if (!event.persisted) return;
            observer.observe(document.body, config);
            update();
        });
    }

    function setFileAcceptAttribute(selector) {
        document.querySelectorAll(selector).forEach(input => {
            input.setAttribute('accept', '.xlsx, .xls');
        });
    }

    // Начальные значения задаём однократно, чтобы сохранить последующие правки пользователя.
    function fillFieldOnce(selector, value) {
        document.querySelectorAll(selector).forEach(input => {
            if (initializedFields.has(input)) return;
            input.value = value;
            initializedFields.add(input);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
    }

    // Переключаем флажок только при несовпадении состояния, учитывая оформление iCheck.
    function setCheckboxOnce(input, checked, silent = false) {
        if (!input || initializedFields.has(input)) return;
        initializedFields.add(input);
        if (silent) {
            // Начальное состояние не должно запускать пересоздание таблицы через change/iCheck.
            input.checked = checked;
            const wrapper = input.closest('.icheckbox_minimal');
            wrapper?.classList.toggle('checked', checked);
            wrapper?.setAttribute('aria-checked', String(checked));
            return;
        }
        if (input.checked === checked) return;
        const wrapper = input.closest('.icheckbox_minimal');
        const helper = input.parentElement?.querySelector('.iCheck-helper');
        if (helper) helper.click();
        else if (wrapper) wrapper.click();
        else input.click();
        if (input.checked !== checked) {
            input.checked = checked;
            wrapper?.classList.toggle('checked', checked);
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    function formatPriceDate(date) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    // Используем местную дату и ограничиваем день последним днём нужного месяца.
    function getPreviousMonthDate(now = new Date(), months = 1) {
        const date = new Date(now.getFullYear(), now.getMonth(), 1);
        date.setMonth(date.getMonth() - months);
        const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
        date.setDate(Math.min(now.getDate(), lastDay));
        return formatPriceDate(date);
    }

    function getAutoPriceStartDate(period, customStart, now = new Date()) {
        if (period === 'custom') return customStart;
        if (period === 'half-year') return getPreviousMonthDate(now, 6);
        if (period === 'year') return getPreviousMonthDate(now, 12);
        const start = new Date(now);
        start.setDate(start.getDate() - Number(period));
        return formatPriceDate(start);
    }

    function isRelevanceFile(file) {
        return Boolean(file && /\.(xlsx|xls)$/i.test(file.name) && file.size > 0);
    }

    function initPriceRelevance() {
        observePage(() => {
            setFileAcceptAttribute('input[type="file"][name="price"]');
            fillFieldOnce('input[name="outStart"]', RELEVANCE_DEFAULTS.outStart);
            fillFieldOnce('input[name="start_date"]', getPreviousMonthDate());
            setCheckboxOnce(document.querySelector('input[name="orders_avg_cost"]'), RELEVANCE_DEFAULTS.orders_avg_cost);
            setCheckboxOnce(document.querySelector('input[name="orders_max_cost"]'), RELEVANCE_DEFAULTS.orders_max_cost);
            enhancePriceRelevance();
        });
    }

    // Процент относится только к строкам или передаче файла, а не ко всей работе сервера.
    function parseRelevanceStatus(text) {
        if (!text.trim()) return { stage: 'idle', percent: null };
        if (/ошиб|не удалось|необходимым параметром/i.test(text)) return { stage: 'error', percent: null };
        if (/файл сформирован/i.test(text)) return { stage: 'done', percent: null };
        if (/подготовка результата/i.test(text)) return { stage: 'preparing', percent: null };
        const rows = text.match(/обработано\s*:?\s*([\d\s\u00a0]+?)\s+строк(?:и|а)?\s+из\s+([\d\s\u00a0]+)/i);
        if (rows) {
            const processed = Number(rows[1].replace(/\s/g, ''));
            const total = Number(rows[2].replace(/\s/g, ''));
            return { stage: 'processing', processed, total,
                percent: total > 0 ? Math.min(100, Math.max(0, processed / total * 100)) : null };
        }
        if (/начата обработка/i.test(text)) return { stage: 'processing', percent: null };
        if (/ожидается обработка|очеред/i.test(text)) return { stage: 'queued', percent: null };
        return { stage: 'unknown', percent: null };
    }

    function decodeRelevanceMessage(value) {
        const text = String(value ?? '');
        // POST /list может возвращать JSON-строку с \uXXXX, а также обычный текст или HTML.
        try {
            const decoded = JSON.parse(text);
            if (typeof decoded === 'string') return decoded;
        } catch { /* Обычные сообщения и HTML не требуют декодирования JSON. */ }
        return text;
    }

    function readRelevanceMessage(html) {
        const template = document.createElement('template');
        template.innerHTML = decodeRelevanceMessage(html);
        const message = template.content.textContent.trim();
        const parsed = parseRelevanceStatus(message);
        const links = [];
        // Переносим только текст и безопасные ссылки результата, сохраняя штатное скачивание.
        template.content.querySelectorAll('a[href]').forEach(link => {
            try {
                const url = new URL(link.getAttribute('href'), window.location.href);
                if (url.origin === window.location.origin && /^https?:$/.test(url.protocol)) {
                    links.push({ href: url.href, text: link.textContent.trim() || 'Загрузить результат' });
                }
            } catch { /* Некорректная ссылка не должна мешать обновлению статуса. */ }
        });
        return { ...parsed, message, links };
    }

    function relevanceServerBusy(stage, inProcess) {
        return inProcess === true || ['queued', 'processing', 'preparing'].includes(stage);
    }

    function applyRelevanceMessage(html, inProcess) {
        applyRelevanceStatus(readRelevanceMessage(html), inProcess);
    }

    function applyRelevanceStatus(parsed, inProcess) {
        const state = relevanceProgress;
        Object.assign(state, parsed, { warning: '' });
        const busy = relevanceServerBusy(state.stage, inProcess);
        if (state.revision > 0 && relevanceAnalysis.armed && busy) relevanceAnalysis.accepted = true;
        // В очереди сервер возвращает inProcess=false: это ещё не завершение задания.
        state.busy = busy;
        if (state.busy && !state.started) state.started = Date.now();
        if (state.busy) state.finished = null;
        else if (state.started && !state.finished) state.finished = Date.now();
        if (state.stage === 'error') relevanceAnalysis.armed = false;
        state.notify();
        if (state.stage === 'done' && !state.busy && relevanceAnalysis.armed && relevanceAnalysis.accepted && state.links.length) {
            relevanceAnalysis.armed = false;
            relevanceAnalysis.reportTask = startRelevanceAnalysis();
        }
    }

    function relevanceAnalysisRunning() {
        return ['downloading', 'loading', 'reading', 'calculating'].includes(relevanceAnalysis.phase);
    }

    function stopRelevanceAnalysis(message = '') {
        const analysis = relevanceAnalysis;
        analysis.token++;
        analysis.controller?.abort(); analysis.controller = null;
        analysis.worker?.terminate(); analysis.worker = null;
        clearTimeout(analysis.timer); analysis.timer = null;
        if (message) {
            Object.assign(analysis, { phase: 'error', message, percent: null, finished: Date.now(), armed: false });
            relevanceProgress.notify();
        }
    }

    function resetRelevanceAnalysis(body) {
        stopRelevanceAnalysis();
        const analysis = relevanceAnalysis;
        if (analysis.blobUrl) URL.revokeObjectURL(analysis.blobUrl);
        Object.assign(analysis, { phase: 'idle', revision: relevanceProgress.revision, armed: true, accepted: false,
            percent: null, message: '', result: null, started: null, finished: null, blob: null, blobUrl: '', source: '',
            fileName: '', reportTask: null, sourceName: body?.get?.('price')?.name || '', outputStart: body?.get?.('outStart') ?? null });
    }

    // Эта функция выполняется в отдельном потоке; денежные операции повторяют Decimal в ARM.
    function calculateRelevanceWorkbook(workbook, XLSX, Decimal, progress = () => {}) {
        Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });
        const normalize = value => String(value ?? '').replace(/\u00a0/g, ' ').trim().replace(/\s+/g, ' ').toLowerCase();
        const number = value => {
            if (value === null || value === undefined || typeof value === 'boolean') return null;
            const text = String(value).replace(/[ \u00a0]/g, '').trim().replace(',', '.');
            if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
            try { const result = new Decimal(text); return result.isFinite() ? result : null; } catch { return null; }
        };
        const cell = (sheet, row, col) => {
            const value = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
            return value?.t === 'e' ? null : value?.v;
        };
        const candidates = [];
        let ambiguous = false;
        for (const name of workbook.SheetNames) {
            const sheet = workbook.Sheets[name];
            if (!sheet?.['!ref']) continue;
            const range = XLSX.utils.decode_range(sheet['!ref']);
            const orders = [], minimum = [];
            for (let row = 0; row <= Math.min(9, range.e.r); row++) {
                for (let col = 5; col <= range.e.c; col++) {
                    const header = normalize(cell(sheet, row, col));
                    if (header.startsWith('заказов адео')) orders.push({ row, col });
                    if (header === 'мин. цена заказа') minimum.push({ row, col });
                }
            }
            if (orders.length > 1 || minimum.length > 1) { ambiguous = true; continue; }
            if (orders.length !== 1 || minimum.length !== 1 || range.e.c < 4) continue;
            const first = Math.max(orders[0].row, minimum[0].row) + 1;
            let start = first;
            for (; start <= range.e.r; start++) {
                const identity = [0, 1, 2].some(col => ![undefined, null, ''].includes(cell(sheet, start, col)));
                if (identity && (number(cell(sheet, start, 3)) !== null || number(cell(sheet, start, 4)) !== null)) break;
            }
            if (start > range.e.r) throw new Error('В Excel-файле не найдены строки данных.');
            candidates.push({ name, sheet, start, end: range.e.r, lastColumn: range.e.c, orders: orders[0].col, minimum: minimum[0].col });
        }
        candidates.sort((a, b) => Number(!a.name.toLowerCase().includes('price_analyse_result')) - Number(!b.name.toLowerCase().includes('price_analyse_result')));
        if (!candidates.length) throw new Error(ambiguous ? 'Невозможно однозначно определить столбцы: найдены повторяющиеся заголовки.' :
            'Не найдены столбцы «Заказов АДЕО» и «Мин. цена заказа» начиная с F в первых 10 строках. Включите их в настройках формирования файла.');
        const structure = candidates[0];
        let rub = new Decimal(0), maximum = new Decimal(0), percentages = new Decimal(0);
        let percentageCount = 0, ordered = 0, total = 0, skipped = 0, warningCount = 0;
        const warnings = [];
        const errors = [];
        const unprocessedBrands = new Set();
        const brandHeaders = new Set(['brand', 'brands', 'brand name', 'brandname', 'manufacturer', 'manufacturers',
            'make', 'maker', 'producer', 'firm', 'marque', 'trademark', 'vendor',
            'бренд', 'бренды', 'брэнд', 'брэнды', 'фирма', 'производитель', 'производители', 'марка', 'изготовитель',
            'торговая марка', 'название бренда', 'наименование бренда', 'название производителя', 'наименование производителя']);
        const isBrandHeader = value => normalize(value).replace(/[:：]+$/, '').replace(/_/g, ' ')
            .split(/\s*[/\\|]\s*/).every(part => brandHeaders.has(part.trim().replace(/\s+/g, ' ')));
        const fields = [['Наличие', 3], ['Цена', 4], ['Заказов АДЕО', structure.orders], ['Мин. цена заказа', structure.minimum]];
        const warn = (row, field, reason) => {
            warningCount++;
            if (warnings.length < 200) warnings.push({ row: row + 1, field, reason });
        };
        const rowCount = structure.end - structure.start + 1;
        for (let row = structure.start; row <= structure.end; row++) {
            const processed = row - structure.start + 1;
            if (processed === 1 || processed % 500 === 0 || processed === rowCount) progress(processed, rowCount);
            const footer = String(cell(structure.sheet, row, 0) ?? '').trim().match(/^не\s+найдены\s+бренды(?:\s*:\s*([\s\S]*))?\s*$/i);
            if (footer) {
                const values = [footer[1] ?? ''];
                for (let col = 1; col <= structure.lastColumn; col++) values.push(String(cell(structure.sheet, row, col) ?? ''));
                const brands = new Map();
                values.forEach(value => value.split(/[,;\r\n]+/).forEach(part => {
                    const brand = part.trim().replace(/\s+/g, ' ');
                    const key = normalize(brand);
                    // Заголовок исходного прайса иногда попадает в серверный список ошибок.
                    if (key && !isBrandHeader(brand) && !brands.has(key)) { brands.set(key, brand); unprocessedBrands.add(key); }
                }));
                if (brands.size) errors.push({ code: 'UNPROCESSED_BRANDS', row: row + 1, brands: Array.from(brands.values()) });
                // Итоговая служебная строка не участвует в денежных расчётах.
                continue;
            }
            const rawMinimum = cell(structure.sheet, row, structure.minimum);
            if (rawMinimum === null || rawMinimum === undefined || !String(rawMinimum).trim()) continue;
            total++;
            const values = fields.map(([, col]) => number(cell(structure.sheet, row, col)));
            let invalid = false;
            values.forEach((value, index) => {
                if (value === null) { invalid = true; warn(row, fields[index][0], 'Не удалось преобразовать значение в число'); }
            });
            if (invalid) { skipped++; continue; }
            const [availability, price, orders, minimum] = values;
            const quantity = Decimal.min(availability, orders);
            if (price.lte(minimum)) { rub = rub.plus(price.times(quantity)); ordered++; }
            maximum = maximum.plus(Decimal.min(price, minimum).times(quantity));
            if (!price.isZero()) { percentages = percentages.plus(price.minus(minimum).div(price)); percentageCount++; }
            else warn(row, 'Цена', 'Процент не рассчитан: цена равна нулю');
        }
        return {
            result: { rub_sum: rub.trunc().toFixed(0), ordered_from_supplier: ordered, total_orders: total,
                average_percent: percentageCount ? percentages.div(percentageCount).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null,
                maximum_rub: maximum.trunc().toFixed(0) },
            meta: { sheet_name: structure.name, data_start_row: structure.start + 1, processed_rows: rowCount,
                skipped_rows: skipped, warning_count: warningCount, error_count: errors.length, unprocessed_brand_count: unprocessedBrands.size,
                detected_columns: { availability: 'D', price: 'E',
                    orders: XLSX.utils.encode_col(structure.orders), minimum_order_price: XLSX.utils.encode_col(structure.minimum) } }, warnings, errors
        };
    }

    function relevanceAnalysisWorker(calculate) {
        self.onmessage = event => {
            try {
                self.postMessage({ phase: 'loading', message: 'Подготовка модуля анализа…' });
                if (typeof XLSX === 'undefined' || typeof Decimal === 'undefined') {
                    throw new Error('Модуль анализа отсутствует в скрипте. Установите полную версию скрипта и обновите страницу.');
                }
                self.postMessage({ phase: 'reading', message: 'Чтение Excel-файла… На больших файлах это может занять время.' });
                let workbook;
                try { workbook = XLSX.read(event.data.buffer, { type: 'array', cellFormula: false, cellHTML: false, cellText: false }); }
                catch { throw new Error('Не удалось прочитать Excel-файл: файл повреждён или имеет неподдерживаемый формат.'); }
                self.postMessage({ phase: 'calculating', message: 'Определение столбцов и расчёт показателей…' });
                const result = calculate(workbook, XLSX, Decimal, (processed, total) => {
                    self.postMessage({ phase: 'calculating', percent: processed / total * 100,
                        message: `Проанализировано ${processed} строк из ${total}` });
                });
                self.postMessage({ phase: 'done', message: 'Анализ завершён', result });
            } catch (error) { self.postMessage({ phase: 'error', message: error.message || 'Не удалось проанализировать файл.' }); }
        };
    }

    async function startRelevanceAnalysis() {
        const analysis = relevanceAnalysis;
        const state = relevanceProgress;
        const link = state.links[0];
        if (relevanceAnalysisRunning() || state.busy || state.stage !== 'done' || !link) return;
        stopRelevanceAnalysis();
        const token = analysis.token;
        const revision = state.revision;
        Object.assign(analysis, { phase: 'downloading', armed: false, revision, started: Date.now(), finished: null,
            percent: null, message: 'Получение готового Excel для анализа…', result: null });
        state.notify();
        const current = () => token === analysis.token && revision === state.revision;
        const fail = message => { if (current()) stopRelevanceAnalysis(message); };
        try {
            if (analysis.outputStart !== null && analysis.outputStart !== undefined && Number(analysis.outputStart) < 5) {
                throw new Error('Для анализа по правилам ARM добавляйте результирующие колонки после 5-го столбца или дальше, чтобы сохранить наличие в D и цену в E.');
            }
            let buffer;
            if (analysis.blob && analysis.source === link.href) buffer = await analysis.blob.arrayBuffer();
            else {
                analysis.controller = new AbortController();
                analysis.timer = setTimeout(() => fail('Сервер слишком долго передаёт результат. Можно повторить анализ или скачать Excel.'), 90000);
                const response = await fetch(link.href, { credentials: 'same-origin', cache: 'no-store', signal: analysis.controller.signal });
                if (!current()) return;
                if (!response.ok) throw new Error(`Не удалось получить результат: HTTP ${response.status}.`);
                const limit = 50 * 1024 * 1024;
                if (Number(response.headers.get('content-length')) > limit) throw new Error('Файл больше 50 МБ. Скачайте его для анализа вне браузера.');
                const reader = response.body.getReader();
                const chunks = []; let length = 0;
                while (true) {
                    const { value, done } = await reader.read();
                    if (!current()) { await reader.cancel(); return; }
                    if (done) break;
                    length += value.byteLength;
                    if (length > limit) { await reader.cancel(); throw new Error('Файл больше 50 МБ. Скачайте его для анализа вне браузера.'); }
                    chunks.push(value);
                }
                buffer = new Uint8Array(length);
                let offset = 0;
                for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
                buffer = buffer.buffer;
                const bytes = new Uint8Array(buffer);
                const xlsx = bytes[0] === 0x50 && bytes[1] === 0x4b;
                if (!xlsx) throw new Error('Вместо отчёта XLSX сервер вернул другой ответ. Возможно, сессия истекла; обновите страницу.');
                analysis.blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
                if (analysis.blobUrl) URL.revokeObjectURL(analysis.blobUrl);
                analysis.blobUrl = URL.createObjectURL(analysis.blob);
                analysis.fileName = 'price_relevance_result.xlsx';
                analysis.source = link.href;
            }
            if (!current()) return;
            clearTimeout(analysis.timer); analysis.controller = null;
            analysis.phase = 'loading'; analysis.message = 'Подготовка модуля анализа…'; state.notify();
            const workerUrl = URL.createObjectURL(new Blob([getRelevanceWorkerSources(), '\n;\n',
                `(${relevanceAnalysisWorker.toString()})(${calculateRelevanceWorkbook.toString()});`], { type: 'application/javascript' }));
            try { analysis.worker = new Worker(workerUrl); }
            catch { throw new Error('Браузер не разрешил фоновый анализ. Можно скачать Excel или повторить анализ после проверки разрешений браузера.'); }
            finally { URL.revokeObjectURL(workerUrl); }
            analysis.worker.onerror = event => {
                event.preventDefault(); fail('Не удалось запустить анализ. Обновите страницу и повторите попытку. Если ошибка повторяется, проверьте разрешение фоновой обработки в браузере.');
            };
            analysis.worker.onmessage = event => {
                if (!current()) return;
                Object.assign(analysis, event.data, { percent: event.data.percent ?? null });
                if (['done', 'error'].includes(analysis.phase)) {
                    analysis.finished = Date.now(); analysis.worker.terminate(); analysis.worker = null;
                    clearTimeout(analysis.timer); analysis.timer = null;
                }
                state.notify();
            };
            analysis.timer = setTimeout(() => fail('Анализ выполняется дольше 5 минут и остановлен. Можно повторить его или скачать Excel.'), 300000);
            analysis.worker.postMessage({ buffer }, [buffer]);
        } catch (error) { fail(error.name === 'TypeError' ? 'Не удалось получить файл для анализа. Проверьте соединение и повторите попытку.' : error.message || 'Не удалось проанализировать файл.'); }
    }

    // Наблюдаем за штатными запросами страницы: дополнительных отправок и опросов нет.
    function installRelevanceProgress() {
        if (!/^\/admin\/admin_pricerelevance\/list\/?$/.test(window.location.pathname) ||
            typeof XMLHttpRequest === 'undefined') return;
        const prototype = XMLHttpRequest.prototype;
        const originalOpen = prototype.open;
        const originalSend = prototype.send;
        const requests = new WeakMap();
        let pollSequence = 0;
        let lastPoll = 0;
        prototype.open = function (method, url, ...args) {
            requests.delete(this);
            const result = originalOpen.call(this, method, url, ...args);
            const address = new URL(url, window.location.href);
            const verb = String(method).toUpperCase();
            if (address.origin === window.location.origin) {
                if (verb === 'POST' && /^\/admin\/admin_pricerelevance\/list\/?$/.test(address.pathname)) requests.set(this, 'upload');
                if (verb === 'GET' && address.pathname === '/admin/admin_pricerelevance/state') requests.set(this, 'state');
            }
            return result;
        };
        prototype.send = function (body) {
            const kind = requests.get(this);
            if (!kind) return originalSend.call(this, body);
            const state = relevanceProgress;
            if (kind === 'upload') {
                Object.assign(state, { stage: 'uploading', busy: true, uploading: true, percent: null,
                    message: 'Отправляем файл на сервер…', links: [], warning: '', started: Date.now(), finished: null,
                    revision: state.revision + 1 });
                resetRelevanceAnalysis(body);
                state.notify();
                this.upload?.addEventListener('progress', event => {
                    if (!state.uploading) return;
                    state.percent = event.lengthComputable && event.total > 0 ? event.loaded / event.total * 100 : null;
                    state.message = state.percent === 100 ? 'Файл передан. Ожидаем подтверждение сервера…' : 'Отправляем файл на сервер…';
                    state.notify();
                });
            }
            const revision = state.revision;
            const sequence = kind === 'state' ? ++pollSequence : 0;
            const ignoredPoll = kind === 'state' && state.uploading;
            let settled = false;
            const fail = message => {
                if (revision !== state.revision || ignoredPoll || (kind === 'state' && (state.uploading || sequence < lastPoll))) return;
                if (kind === 'upload') {
                    relevanceAnalysis.armed = false;
                    Object.assign(state, { stage: 'error', busy: false, uploading: false, percent: null,
                        message, finished: Date.now(), links: [] });
                } else {
                    lastPoll = sequence;
                    state.warning = `${message} Повторная проверка статуса — автоматически.`;
                }
                state.notify();
            };
            this.addEventListener('load', () => {
                settled = true;
                if (revision !== state.revision || ignoredPoll || (kind === 'state' && (state.uploading || sequence < lastPoll))) return;
                if (kind === 'state') lastPoll = sequence;
                if (this.status < 200 || this.status >= 300) { fail(`Ошибка сервера: HTTP ${this.status}.`); return; }
                try {
                    if (kind === 'state') {
                        const data = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
                        if (typeof data?.message !== 'string' || typeof data.inProcess !== 'boolean') throw new Error('Неизвестный ответ');
                        applyRelevanceMessage(data.message, data.inProcess);
                    } else {
                        state.uploading = false;
                        const message = this.responseType === 'json' ? this.response : this.responseText;
                        const parsed = readRelevanceMessage(message);
                        // Готовность из ответа самого POST относится к новому заданию.
                        if (parsed.stage === 'done') relevanceAnalysis.accepted = true;
                        applyRelevanceStatus(parsed);
                        if (state.stage === 'unknown' || state.stage === 'idle') {
                            Object.assign(state, { stage: 'queued', busy: true, message: state.message || 'Файл отправлен. Ожидаем обработку…', finished: null });
                            state.notify();
                        }
                    }
                } catch { fail('Не удалось прочитать ответ сервера.'); }
            });
            this.addEventListener('loadend', () => {
                if (!settled) fail('Нет подтверждения от сервера: запрос прерван или потеряна связь. Проверьте статус перед повторной отправкой.');
            });
            try { return originalSend.call(this, body); }
            catch (error) { fail('Не удалось отправить запрос.'); throw error; }
        };
    }

    async function getAutoPriceResponse(path, signal, headers) {
        const response = await fetch(path, {
            credentials: 'same-origin', cache: 'no-store', headers,
            signal: AbortSignal.any([signal, AbortSignal.timeout(15000)])
        });
        if (!response.ok) throw new Error(`Ошибка ADEO: HTTP ${response.status}.`);
        return response;
    }

    async function getAutoPriceStatus(signal) {
        const response = await getAutoPriceResponse('/admin/admin_pricerelevance/state', signal, {
            'X-Requested-With': 'XMLHttpRequest'
        });
        const data = await response.json().catch(() => null);
        if (typeof data?.message !== 'string' || typeof data.inProcess !== 'boolean') {
            throw new Error('ADEO не вернул статус проверки. Проверьте, что вы вошли в ADEO.');
        }
        return { status: readRelevanceMessage(data.message), inProcess: data.inProcess };
    }

    async function getAutoPriceForm(file, startDate, signal) {
        const response = await getAutoPriceResponse(PRICE_RELEVANCE_PATH, signal);
        // Читаем исходные значения и скрытые поля формы без запуска скриптов ADEO.
        const source = document.createElement('template');
        source.innerHTML = await response.text();
        const form = source.content.querySelector('#price-form');
        if (!form?.querySelector('input[type=file][name=price]')) {
            throw new Error('ADEO не вернул форму проверки. Проверьте, что вы вошли в ADEO.');
        }
        for (const [name, value] of Object.entries({ ...RELEVANCE_DEFAULTS, start_date: startDate })) {
            const field = form.querySelector(`input[name="${name}"]`);
            if (!field) continue;
            if (typeof value === 'boolean') field.checked = value;
            else field.value = value;
        }
        const body = new FormData(form);
        body.set('price', file);
        return body;
    }

    function uploadAutoPrice(body, signal) {
        return new Promise(resolve => {
            const request = new XMLHttpRequest();
            request.open('POST', PRICE_RELEVANCE_PATH);
            request.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
            request.timeout = 120000;
            const abort = () => request.abort();
            signal.addEventListener('abort', abort, { once: true });
            try {
                request.send(body);
            } catch (error) {
                signal.removeEventListener('abort', abort);
                throw error;
            }
            // Сначала штатный обработчик скрипта разбирает ответ на отправку.
            request.addEventListener('loadend', () => {
                signal.removeEventListener('abort', abort);
                resolve();
            }, { once: true });
        });
    }

    async function followAutoPriceCheck(previous, signal) {
        const state = relevanceProgress;
        let sawActive = false;
        let lastConfirmed = Date.now();
        while (state.busy && !signal.aborted && Date.now() - lastConfirmed < 60000) {
            let response;
            try {
                response = await getAutoPriceStatus(signal);
            } catch (error) {
                if (signal.aborted) return;
                state.warning = `${error.message} Повторная проверка статуса — автоматически.`;
                state.notify();
            }
            if (signal.aborted) return;
            if (response) {
                const { status, inProcess } = response;
                const active = relevanceServerBusy(status.stage, inProcess);
                // До первого активного статуса сервер может ещё отдавать предыдущий отчёт.
                const sameResult = status.message === previous.message &&
                    status.links[0]?.href === previous.links[0]?.href;
                if (active) {
                    sawActive = true;
                    lastConfirmed = Date.now();
                    applyRelevanceStatus(status, inProcess);
                } else if ((sawActive || !sameResult) &&
                    (status.stage === 'error' || (status.stage === 'done' && status.links.length))) {
                    relevanceAnalysis.accepted = true;
                    applyRelevanceStatus(status, false);
                }
            }
            if (state.busy) await new Promise(resolve => setTimeout(resolve, 2500));
        }
        if (state.busy && !signal.aborted) {
            relevanceAnalysis.armed = false;
            Object.assign(state, { stage: 'error', busy: false, percent: null, finished: Date.now(), links: [],
                message: 'Не удалось подтвердить завершение проверки в ADEO. Проверьте статус задания перед повторной отправкой.' });
            state.notify();
        }
    }

    async function requestTestPriceJson(path, signal, body) {
        const response = await fetch(path, {
            method: 'POST', body, credentials: 'same-origin', cache: 'no-store',
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
            signal: AbortSignal.any([signal, AbortSignal.timeout(body ? 120000 : 15000)])
        });
        if (!response.ok) throw new Error(`Ошибка ADEO: HTTP ${response.status}.`);
        const data = await response.json().catch(() => null);
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error('ADEO вернул неожиданный ответ. Проверьте, что вы вошли в ADEO.');
        }
        return data;
    }

    async function getTestPriceImportState(jobId, signal) {
        const job = await requestTestPriceJson(`/admin/piqueue/item/info/${jobId}`, signal);
        const state = Number(job.state);
        if (job.state == null || !Number.isInteger(state)) {
            throw new Error('ADEO не вернул статус задания импорта.');
        }
        return { active: state === 1 || state === 2, info: job.info };
    }

    async function getTestPriceQueueJobId(target, signal) {
        const queue = await requestTestPriceJson(`/admin/piqueue/cella/inqueue/${target}`, signal);
        const jobId = Number(queue.job_id ?? 0);
        if (!Number.isSafeInteger(jobId)) throw new Error('ADEO вернул неизвестный номер задания импорта.');
        return jobId;
    }

    async function isTestPriceImportActive(target, signal) {
        const jobId = await getTestPriceQueueJobId(target, signal);
        return jobId > 0 && (await getTestPriceImportState(jobId, signal)).active;
    }

    function readTestPriceImportInfo(info) {
        const template = document.createElement('template');
        template.innerHTML = typeof info === 'string' ? info : '';
        return template.content.textContent.trim();
    }

    function readTestPriceJsonp(callback, signal, { href, source }) {
        return new Promise((resolve, reject) => {
            signal.throwIfAborted();
            const frame = document.createElement('iframe');
            frame.hidden = true;
            frame.setAttribute('sandbox', 'allow-scripts');
            const quote = value => JSON.stringify(value).replaceAll('<', '\\u003c');
            // JSONP выполняется в документе без доступа к странице ADEO.
            const load = href ? `script.src = ${quote(href)};` : `script.text = ${quote(source)};`;
            frame.srcdoc = `<script>
                const send = value => parent.postMessage(value, ${quote(window.location.origin)});
                window[${quote(callback)}] = send;
                const script = document.createElement('script');
                ${load}
                script.onload = script.onerror = () => send(null);
                document.head.append(script);
                ${href ? '' : 'send(null);'}
            </script>`;
            function cleanup() {
                window.removeEventListener('message', receive);
                signal.removeEventListener('abort', abort);
                frame.remove();
            }
            function receive(event) {
                if (event.source !== frame.contentWindow || event.origin !== 'null') return;
                cleanup();
                resolve(event.data);
            }
            function abort() {
                cleanup();
                reject(signal.reason);
            }
            window.addEventListener('message', receive);
            signal.addEventListener('abort', abort, { once: true });
            document.body.append(frame);
        });
    }

    async function confirmTestPriceImport(value, path, signal) {
        if (typeof value !== 'string' || !value.trim()) throw new Error('ADEO не вернул адрес подтверждения импорта.');
        const url = new URL(value, new URL(path, window.location.origin));
        if (url.protocol !== 'https:' || url.username || url.password) {
            throw new Error('ADEO вернул недопустимый адрес подтверждения импорта.');
        }
        url.hash = '';
        const callback = 'adeoConfirmTestPriceImport';
        const withCallback = url.href.replace(/(=)\?(?=&|$)|\?\?/, `$1${callback}`);
        const href = withCallback === url.href ? `${url.href}${url.search ? '&' : '?'}callback=${callback}` : withCallback;
        const timeout = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
        if (url.origin !== window.location.origin) return readTestPriceJsonp(callback, timeout, { href });

        const response = await fetch(href, { credentials: 'same-origin', cache: 'no-store', signal: timeout });
        if (!response.ok) throw new Error(`Не удалось подтвердить импорт: HTTP ${response.status}.`);
        const text = (await response.text()).trim();
        const jsonp = text.match(/^(?:\/\*\*\/\s*)?adeoConfirmTestPriceImport\s*\(([\s\S]*)\)\s*;?$/);
        try { return JSON.parse(jsonp ? jsonp[1] : text); }
        catch {
            if (jsonp) return readTestPriceJsonp(callback, timeout, { source: text });
            throw new Error('ADEO вернул неизвестный ответ при подтверждении импорта.');
        }
    }

    function renderTestPriceImportLog(results, html) {
        const source = document.createElement('template');
        source.innerHTML = html;
        const entries = Array.from(source.content.querySelectorAll('.gen_td'), cell => {
            const summary = cell.querySelector('summary');
            return { text: (summary ?? cell).textContent.trim(), details: summary?.parentElement };
        });
        const rows = entries.length ? entries : source.content.textContent.split(/\r?\n/).map(text => ({ text: text.trim() }));
        const grid = document.createElement('div');
        grid.className = 'adeo-analysis-grid';
        const heading = document.createElement('h3');
        heading.textContent = 'Ошибки и пропуски';
        const issues = document.createElement('div');
        issues.className = 'adeo-auto-price-import-errors';
        const metrics = [
            ['Всего строк', /^(?:Импорт окончен\.\s*)?(?:Строк всего|Всего строк)\s*:\s*/i],
            ['Импортировано строк', /^Импортировано(?:\s+строк)?\s*:\s*/i],
            ['Отсутствует или неверный артикул', /^Отсутствует или неверный артикул\s*:\s*/i, 'details'],
            ['Нулевые остатки', /^Нулевые остатки\s*:\s*/i, 'count'],
            ['Неизвестных брендов', /^Неизвестных брендов\s*:\s*/i, 'details']
        ];
        const formatter = new Intl.NumberFormat('ru-RU');
        for (const [label, pattern, issue] of metrics) {
            const row = rows.findLast(entry => pattern.test(entry.text));
            const value = row?.text.replace(pattern, '').match(/^\d+(?:[ \u00a0\u202f]\d{3})*/)?.[0];
            const count = value ? formatter.format(BigInt(value.replace(/\s/g, ''))) : 'Нет данных';
            if (!issue) {
                const card = document.createElement('article');
                const title = document.createElement('span');
                title.textContent = label;
                const amount = document.createElement('strong');
                amount.textContent = count;
                card.append(title, amount);
                grid.append(card);
                continue;
            }
            const dataRows = issue === 'details' && row?.details?.querySelectorAll('table tr');
            if (!dataRows?.length) {
                const line = document.createElement('p');
                line.textContent = `${label}: ${count}`;
                issues.append(line);
                continue;
            }
            const details = document.createElement('details');
            const summary = document.createElement('summary');
            summary.textContent = `${label}: ${count}`;
            const list = document.createElement('ul');
            for (const dataRow of dataRows) {
                const cell = dataRow.cells[1];
                if (!cell) continue;
                const item = document.createElement('li');
                item.textContent = cell.textContent.trim() || 'Пустое значение';
                list.append(item);
            }
            details.append(summary, list);
            issues.append(details);
        }
        results.replaceChildren(grid, heading, issues);
    }

    async function showTestPriceImportLog(results, jobId, signal) {
        results.hidden = false;
        results.textContent = 'Загружаем журнал импорта…';
        try {
            const data = await requestTestPriceJson(`/admin/piqueue/item/log/${jobId}`, signal);
            if (typeof data.log !== 'string' || !data.log.trim()) throw new Error('Журнал пуст.');
            if (!signal.aborted) renderTestPriceImportLog(results, data.log);
        } catch {
            results.textContent = 'Не удалось получить журнал импорта ADEO.';
        }
    }

    async function runTestPriceImport(file, cell, signal, status, results, onImported) {
        const target = `${TEST_PRICE_SUPPLIER}/${cell}`;
        const path = `/admin/supplier/price/comparemode/${target}`;
        status.textContent = 'Проверяем очередь импорта…';
        results.hidden = true;
        results.replaceChildren();
        let acceptedJob = null;
        try {
            await navigator.locks.request(`adeo-test-price-import-${target}`, { signal }, async () => {
                while (!signal.aborted && await isTestPriceImportActive(target, signal)) {
                    status.textContent = 'Тестовая ячейка занята. Импорт начнётся после её освобождения.';
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
                signal.throwIfAborted();
                status.textContent = 'Отправляем прайс в тестовую ячейку…';
                const body = new FormData();
                body.set('price', file);
                const upload = await requestTestPriceJson(path, signal, body);
                status.textContent = 'Подтверждаем задание импорта…';
                const result = await confirmTestPriceImport(upload.url, path, signal);
                const info = readTestPriceImportInfo(result?.info);
                if (info) {
                    status.textContent = info;
                    return;
                }
                const jobId = Number(result?.job_id);
                if (!Number.isSafeInteger(jobId) || jobId <= 0) throw new Error('ADEO не подтвердил создание задания импорта.');
                acceptedJob = jobId;
                status.textContent = `ADEO принял задание импорта №${jobId}.`;
                while (!signal.aborted) {
                    const job = await getTestPriceImportState(jobId, signal);
                    const jobInfo = readTestPriceImportInfo(job.info);
                    if (jobInfo) status.textContent = jobInfo;
                    if (!job.active) {
                        const imported = /^Импорт окончен\.\s*Строк(?: всего)?\s*:\s*\d+/i.test(jobInfo);
                        const nextReport = imported ? onImported?.(jobId) : undefined;
                        await showTestPriceImportLog(results, jobId, signal);
                        await nextReport;
                        return;
                    }
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            });
        } catch (error) {
            if (signal.aborted) status.textContent = 'Ожидание прервано. Проверьте очередь импорта в ADEO.';
            else if (acceptedJob) status.textContent = `ADEO принял задание импорта №${acceptedJob}. Не удалось обновить его статус.`;
            else if (error.name === 'TimeoutError' || error.name === 'TypeError') {
                status.textContent = 'Не удалось получить ответ от ADEO. Проверьте очередь импорта перед повторным запуском.';
            } else status.textContent = error.message;
        }
    }

    function requestMarketabilityResource(details, signal, timeout, maxBytes) {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
        return new Promise((resolve, reject) => {
            deadline.throwIfAborted();
            if (typeof GM_xmlhttpRequest !== 'function') throw new Error('В Tampermonkey недоступны запросы к CRM.');
            let request;
            const finish = (callback, value) => {
                deadline.removeEventListener('abort', abort);
                callback(value);
            };
            function abort() {
                finish(reject, deadline.reason);
                request?.abort();
            }
            request = GM_xmlhttpRequest({
                ...details, nocache: true,
                onload: response => finish(resolve, response),
                onerror: () => finish(reject, new Error('Не удалось подключиться к CRM или хранилищу отчётов.')),
                onabort: () => finish(reject, new Error('Запрос отчёта прерван.')),
                onprogress: event => {
                    if (maxBytes && (event.loaded > maxBytes || event.total > maxBytes)) {
                        finish(reject, new Error('Отчёт больше 50 МБ. Его можно скачать из CRM.'));
                        request?.abort();
                    }
                }
            });
            deadline.addEventListener('abort', abort, { once: true });
        });
    }

    async function requestCrmMarketability(query, variables, signal) {
        const response = await requestMarketabilityResource({
            method: 'POST', url: CRM_MARKETABILITY_API, responseType: 'json',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            data: JSON.stringify({ query, variables })
        }, signal, 20000);
        if (response.status === 401 || response.status === 403) {
            throw new Error('CRM не подтвердила сессию. Войдите в CRM в этом браузере.');
        }
        if (response.status < 200 || response.status >= 300) throw new Error(`Ошибка CRM: HTTP ${response.status}.`);
        const payload = response.response;
        if (payload?.errors?.length) throw new Error(payload.errors[0].message || 'CRM отклонила запрос отчёта.');
        if (!payload?.data) throw new Error('CRM вернула неожиданный ответ. Проверьте вход в CRM.');
        return payload.data;
    }

    function decodeMarketabilityActivity(value) {
        if (typeof value !== 'string') return value;
        const text = value.trim();
        const wrapped = /^\{[^{"]+(\{[\s\S]*\})\}$/.exec(text);
        try { return JSON.parse(wrapped?.[1] ?? text); }
        catch { return null; }
    }

    async function waitForCrmMarketability(workflowId, signal) {
        const until = Date.now() + 20 * 60 * 1000;
        while (Date.now() < until) {
            const { workflow } = await requestCrmMarketability(`
                query AutoMarketabilityResult($workflowId: String) {
                    workflow {
                        activityResult(workflowId: $workflowId)
                        list(status: [ALL], workflowType: "OLAPReportWorkflow") { items { id status } }
                    }
                }`, { workflowId }, signal);
            const job = workflow?.list?.items?.find(item => item.id === workflowId);
            if (job && ['FAILED', 'CANCELED', 'TERMINATED', 'TIMED_OUT'].includes(job.status)) {
                throw new Error('CRM завершила задание без отчёта.');
            }
            const activity = decodeMarketabilityActivity(workflow?.activityResult);
            if (activity?.status === false) throw new Error(activity.message || 'CRM не сформировала отчёт.');
            if (activity?.status === true && activity.resource && (!job || job.status === 'COMPLETED')) {
                const url = new URL(activity.resource);
                if (url.origin !== CRM_REPORT_ORIGIN || url.username || url.password) {
                    throw new Error('CRM вернула неизвестный адрес исходного отчёта.');
                }
                return url.href;
            }
            await new Promise(resolve => setTimeout(resolve, 5000));
            signal.throwIfAborted();
        }
        throw new Error('CRM ещё не сформировала отчёт. Проверьте задание по его идентификатору.');
    }

    function analyzeAutoMarketability(buffer, signal, status) {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(300000)]);
        return new Promise((resolve, reject) => {
            deadline.throwIfAborted();
            const url = URL.createObjectURL(new Blob([getRelevanceWorkerSources(), '\n;\n',
                `(${relevanceAnalysisWorker.toString()})(${calculateMarketabilityWorkbook.toString()});`], { type: 'application/javascript' }));
            let worker;
            try { worker = new Worker(url); }
            finally { URL.revokeObjectURL(url); }
            const finish = (callback, value) => {
                deadline.removeEventListener('abort', abort);
                worker.terminate();
                callback(value);
            };
            const abort = () => finish(reject, deadline.reason);
            deadline.addEventListener('abort', abort, { once: true });
            worker.onerror = event => {
                event.preventDefault();
                finish(reject, new Error('Браузер не смог обработать Excel отчёта.'));
            };
            worker.onmessage = ({ data }) => {
                if (data.phase === 'done') finish(resolve, data.result);
                else if (data.phase === 'error') finish(reject, new Error(data.message));
                else status.textContent = data.message;
            };
            worker.postMessage({ buffer }, [buffer]);
        });
    }

    async function runAutoMarketability(cell, importId, options, signal, status, results) {
        const target = `${TEST_PRICE_SUPPLIER}/${cell}`;
        const ensureCurrentImport = async () => {
            const latest = await getTestPriceQueueJobId(target, signal);
            if (latest > 0 && latest !== importId) {
                throw new Error(`После текущего импорта в CellaTEST/${cell} появилось другое задание. Результат нельзя связать с этим файлом.`);
            }
        };
        let workflowId;
        try {
            status.textContent = `Подготавливаем отчёт по CellaTEST/${cell}…`;
            const { supplier } = await requestCrmMarketability(`
                query AutoMarketabilityStorage($supplierId: Int!) {
                    supplier(id: $supplierId) { cella storages { nfile id } }
                }`, { supplierId: Number(TEST_PRICE_SUPPLIER) }, signal);
            const storages = supplier?.storages?.filter(storage => Number(storage.nfile) === Number(cell));
            const storageId = Number(storages?.[0]?.id);
            if (supplier?.cella !== 'CellaTEST' || storages?.length !== 1 || !Number.isSafeInteger(storageId) || storageId <= 0) {
                throw new Error(`CRM не нашла нужный склад CellaTEST/${cell}.`);
            }
            await ensureCurrentImport();
            const parameters = {
                storageId, rankMin: 1, rankMax: 998, clientId: 153893, uniqueOffer: true,
                popularity: false, soldLimit: 10, soldRange: 1, ...options
            };
            status.textContent = `Отправляем отчёт по CellaTEST/${cell} в очередь CRM…`;
            const { olap } = await requestCrmMarketability(`
                mutation AutoGenerateMarketability($input: [KeyValueInput!]!, $reportName: String!) {
                    olap { generateReport(input: $input, reportName: $reportName) }
                }`, {
                input: Object.entries(parameters).map(([key, value]) => ({ key, value: String(value) })),
                reportName: 'PriceCompetitivenessReport'
            }, signal);
            if (typeof olap?.generateReport !== 'string' || !olap.generateReport.trim()) {
                throw new Error('CRM не вернула идентификатор задания. Проверьте очередь CRM перед новым запуском.');
            }
            workflowId = olap.generateReport;
            status.textContent = `Ожидаем отчёт по CellaTEST/${cell}. Задание CRM: ${workflowId}.`;
            const href = await waitForCrmMarketability(workflowId, signal);
            await ensureCurrentImport();
            const link = document.createElement('a');
            link.href = href;
            link.download = '';
            link.textContent = 'Скачать исходный отчёт';
            results.append(link);
            results.hidden = false;
            status.textContent = 'Получаем Excel отчёта CRM…';
            const file = await requestMarketabilityResource({
                method: 'GET', url: href, responseType: 'arraybuffer', anonymous: true
            }, signal, 90000, CRM_REPORT_MAX_BYTES);
            if (file.status < 200 || file.status >= 300) throw new Error(`CRM не передала Excel: HTTP ${file.status}.`);
            const buffer = file.response;
            if (buffer?.byteLength > CRM_REPORT_MAX_BYTES) throw new Error('Отчёт больше 50 МБ. Его можно скачать в Excel.');
            const bytes = new Uint8Array(buffer ?? 0);
            if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('Хранилище вернуло ответ в другом формате вместо Excel.');
            const report = await analyzeAutoMarketability(buffer, signal, status);
            installMarketabilityStyles();
            const metrics = document.createElement('div');
            metrics.className = 'adeo-marketability-metrics';
            const notes = document.createElement('div');
            renderMarketabilitySummary(metrics, notes, report);
            results.append(metrics, notes);
            status.textContent = `Отчёт по CellaTEST/${cell} готов.`;
        } catch (error) {
            const message = error.name === 'TimeoutError' ? 'Истекло время ожидания ответа CRM.' : error.message;
            status.textContent = signal.aborted ? 'Ожидание отчёта прервано.' : message;
        }
        if (workflowId) status.textContent += ` Задание CRM: ${workflowId}.`;
    }

    function openAutoPriceCheckPage() {
        // На этапе document-start создаём собственный документ для отдельного режима проверки.
        const root = document.createElement('html');
        root.lang = 'ru';
        const head = document.createElement('head');
        head.innerHTML = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
        root.append(head, document.createElement('body'));
        if (document.documentElement) document.documentElement.replaceWith(root);
        else document.replaceChildren(document.implementation.createDocumentType('html', '', ''), root);
        document.title = AUTO_PRICE_CHECK_TITLE;
        installQuickLinksMenu();
        installRelevanceStyles();
        document.body.classList.add('adeo-auto-price');
        const main = document.createElement('main');
        main.innerHTML = `
            <h1>${AUTO_PRICE_CHECK_TITLE}</h1>
            <div id="price-form">
                <fieldset class="adeo-auto-price-settings">
                    <legend>Настройки проверки</legend>
                    <div class="adeo-auto-price-actions">
                        <label><input type="checkbox" name="run-sales" checked> Анализ на продаваемость</label>
                        <label><input type="checkbox" name="run-import" checked> Импорт в тестовую целлу</label>
                        <label><input type="checkbox" name="run-marketability" checked> Отчёт о конкурентоспособности</label>
                    </div>
                    <label>Период продаваемости
                        <select name="sales-period">
                            <option value="30">30 дней</option>
                            <option value="90">90 дней</option>
                            <option value="half-year">Полгода</option>
                            <option value="year">Год</option>
                            <option value="custom">Свой период</option>
                        </select>
                    </label>
                    <label>Тестовая ячейка
                        <select name="test-cell">
                            ${Array.from({ length: 10 }, (_, index) => `<option value="${index + 1}">CellaTEST/${index + 1}</option>`).join('')}
                        </select>
                    </label>
                    <label class="adeo-auto-price-custom-start" hidden>Дата начала (по сегодня)
                        <input name="sales-start" type="date" required>
                    </label>
                    <div class="adeo-auto-price-marketability-settings" hidden>
                        <label><input type="checkbox" name="marketability-foreign"> Включать в анализ прайсы заграничных складов</label>
                        <label><input type="checkbox" name="marketability-markup-enabled"> Добавить наценку ко всем позициям в прайсе</label>
                        <label class="adeo-auto-price-markup" hidden>Наценка, %
                            <input type="number" name="marketability-markup" value="10" step="0.1" required>
                        </label>
                    </div>
                </fieldset>
                <div class="adeo-file-card">
                    <label class="adeo-file-info">
                        <span class="adeo-file-name">Выберите прайс</span>
                        <input type="file" accept=".xls,.xlsx" disabled aria-describedby="adeo-auto-price-availability">
                    </label>
                    <div class="adeo-file-hint">XLS или XLSX</div>
                    <button type="button" class="adeo-auto-price-launch" disabled>Запустить</button>
                </div>
                <p class="adeo-file-error" role="alert" hidden></p>
                <section class="adeo-auto-price-sales" aria-labelledby="adeo-auto-price-sales-title">
                    <h2 id="adeo-auto-price-sales-title" class="adeo-auto-price-test">Продаваемость</h2>
                    <p id="adeo-auto-price-availability" class="adeo-auto-price-availability" role="status"></p>
                </section>
                <section class="adeo-auto-price-import" aria-labelledby="adeo-auto-price-import-title">
                    <h2 id="adeo-auto-price-import-title" class="adeo-auto-price-test">Импорт в тестовую ячейку</h2>
                    <p class="adeo-auto-price-import-status" role="status">Ожидает запуска.</p>
                    <section class="adeo-auto-price-import-results adeo-analysis-results" aria-label="Результат импорта" hidden></section>
                </section>
                <section class="adeo-auto-price-import adeo-auto-price-marketability" aria-labelledby="adeo-auto-price-marketability-title" hidden>
                    <h2 id="adeo-auto-price-marketability-title" class="adeo-auto-price-test">Отчёт о конкурентоспособности</h2>
                    <p class="adeo-auto-price-import-status" role="status">Ожидает запуска.</p>
                    <section class="adeo-auto-price-import-results adeo-analysis-results" aria-label="Результат конкурентоспособности" hidden></section>
                </section>
            </div>`;
        document.body.append(main);
        const input = main.querySelector('input[type=file]');
        const launch = main.querySelector('.adeo-auto-price-launch');
        const settings = main.querySelector('.adeo-auto-price-settings');
        const salesOption = settings.querySelector('[name=run-sales]');
        const importOption = settings.querySelector('[name=run-import]');
        const marketabilityOption = settings.querySelector('[name=run-marketability]');
        const marketabilitySettings = settings.querySelector('.adeo-auto-price-marketability-settings');
        const foreignStock = marketabilitySettings.querySelector('[name=marketability-foreign]');
        const markupEnabled = marketabilitySettings.querySelector('[name=marketability-markup-enabled]');
        const markupPercent = marketabilitySettings.querySelector('[name=marketability-markup]');
        const period = settings.querySelector('[name=sales-period]');
        const cellSelect = settings.querySelector('[name=test-cell]');
        const customStart = settings.querySelector('[name=sales-start]');
        const customStartField = customStart.closest('label');
        const storedCell = typeof GM_getValue === 'function' ? String(GM_getValue(TEST_PRICE_CELL_KEY, '1')) : '1';
        if (/^(?:[1-9]|10)$/.test(storedCell)) cellSelect.value = storedCell;
        const salesSection = main.querySelector('.adeo-auto-price-sales');
        const importSection = main.querySelector('.adeo-auto-price-import');
        const marketabilitySection = main.querySelector('.adeo-auto-price-marketability');
        const marketabilityStatus = marketabilitySection.querySelector('[role=status]');
        const marketabilityResults = marketabilitySection.querySelector('.adeo-auto-price-import-results');
        const availability = main.querySelector('#adeo-auto-price-availability');
        const importTitle = main.querySelector('#adeo-auto-price-import-title');
        const importStatus = main.querySelector('.adeo-auto-price-import-status');
        const importResults = main.querySelector('.adeo-auto-price-import-results');
        const error = main.querySelector('.adeo-file-error');
        let reportAvailable = false;
        let availabilityController;
        let availabilityTimer;
        let controller = null;
        function syncControls() {
            customStart.max = formatPriceDate(new Date());
            const customPeriod = salesOption.checked && period.value === 'custom';
            const running = Boolean(controller) || relevanceProgress.busy || relevanceAnalysisRunning();
            const marketability = marketabilityOption.checked;
            if (marketability) importOption.checked = true;
            importOption.disabled = marketability;
            marketabilitySettings.hidden = marketabilitySection.hidden = !marketability;
            markupPercent.closest('label').hidden = !markupEnabled.checked;
            customStartField.hidden = !customPeriod;
            settings.disabled = running;
            period.disabled = !salesOption.checked;
            cellSelect.disabled = !importOption.checked;
            salesSection.hidden = !salesOption.checked;
            importSection.hidden = !importOption.checked;
            input.disabled = running;
            launch.disabled = running || !isRelevanceFile(input.files[0]) ||
                (!salesOption.checked && !importOption.checked) ||
                (salesOption.checked && (!reportAvailable || (customPeriod && !customStart.validity.valid))) ||
                (marketability && markupEnabled.checked && (!markupPercent.validity.valid || !markupPercent.valueAsNumber));
        }
        function waitForReport(message) {
            reportAvailable = false;
            availability.textContent = message;
            syncControls();
            clearTimeout(availabilityTimer);
            availabilityTimer = setTimeout(() => void checkReportAvailability(availabilityController.signal), 5000);
        }
        async function checkReportAvailability(signal) {
            let response;
            try {
                response = await getAutoPriceStatus(signal);
            } catch {
                if (!signal.aborted) waitForReport('Не удалось проверить доступность отчёта ADEO. Пробуем снова…');
                return null;
            }
            if (signal.aborted) return null;
            if (relevanceServerBusy(response.status.stage, response.inProcess)) {
                waitForReport('Отчёт по продаваемости занят другим файлом. Запуск станет доступен, когда отчёт освободится.');
                return null;
            }
            reportAvailable = true;
            availability.textContent = '';
            syncControls();
            return response.status;
        }
        function refreshReportAvailability() {
            clearTimeout(availabilityTimer);
            availabilityController?.abort();
            reportAvailable = false;
            availability.textContent = salesOption.checked ? 'Проверяем доступность отчёта ADEO…' : '';
            syncControls();
            if (salesOption.checked) {
                availabilityController = new AbortController();
                void checkReportAvailability(availabilityController.signal);
            }
        }
        mountRelevanceProgress(availability, syncControls, 'Выберите файл и нажмите «Запустить».');
        relevanceProgress.notify();
        refreshReportAvailability();
        salesOption.addEventListener('change', refreshReportAvailability);
        importOption.addEventListener('change', syncControls);
        marketabilityOption.addEventListener('change', syncControls);
        markupEnabled.addEventListener('change', syncControls);
        markupPercent.addEventListener('input', syncControls);
        period.addEventListener('change', syncControls);
        customStart.addEventListener('input', syncControls);
        cellSelect.addEventListener('change', () => {
            if (typeof GM_setValue === 'function') GM_setValue(TEST_PRICE_CELL_KEY, cellSelect.value);
        });

        input.addEventListener('change', () => {
            const file = input.files[0];
            error.textContent = 'Выберите непустой файл XLS или XLSX.';
            error.hidden = !file || isRelevanceFile(file);
            syncControls();
        });

        launch.addEventListener('click', async () => {
            if (launch.disabled) return;
            const file = input.files[0];
            const runSales = salesOption.checked;
            const runImport = importOption.checked;
            const marketability = marketabilityOption.checked ? {
                foreignStock: foreignStock.checked,
                markupPickup: markupEnabled.checked,
                markupPickupPercent: markupEnabled.checked ? markupPercent.valueAsNumber : 10
            } : null;
            const startDate = runSales ? getAutoPriceStartDate(period.value, customStart.value) : '';
            const cell = cellSelect.value;
            error.hidden = true;
            controller = new AbortController();
            const { signal } = controller;
            const preparing = `Подготовка проверки файла «${file.name}»…`;
            if (runSales) relevanceProgress.message = preparing;
            relevanceProgress.notify();
            let importTask;
            const startImport = () => {
                importTitle.textContent = `Импорт в CellaTEST/${cell}`;
                let onImported;
                let reportStarted = false;
                if (marketability) {
                    marketabilityStatus.textContent = 'Ожидаем успешного импорта в тестовую ячейку…';
                    marketabilityResults.hidden = true;
                    marketabilityResults.replaceChildren();
                    onImported = jobId => {
                        reportStarted = true;
                        return runAutoMarketability(cell, jobId, marketability, signal, marketabilityStatus, marketabilityResults);
                    };
                }
                importTask = runTestPriceImport(file, cell, signal, importStatus, importResults, onImported).finally(() => {
                    if (marketability && !reportStarted) marketabilityStatus.textContent = 'Отчёт не запущен. ADEO не подтвердил успешный импорт.';
                });
            };
            const run = async lock => {
                if (!lock) throw new Error('В другой вкладке уже идёт автоматическая проверка прайса.');
                const body = await getAutoPriceForm(file, startDate, signal);
                const previous = await checkReportAvailability(signal);
                if (!previous || signal.aborted) return;
                if (runImport) startImport();
                await uploadAutoPrice(body, signal);
                if (relevanceProgress.stage === 'done' && !relevanceProgress.links.length) {
                    Object.assign(relevanceProgress, { stage: 'preparing', busy: true, message: 'Ожидаем ссылку на отчёт ADEO…' });
                    relevanceProgress.notify();
                }
                await followAutoPriceCheck(previous, signal);
                await relevanceAnalysis.reportTask;
            };
            try {
                if (runSales) await navigator.locks.request('adeo-auto-price', { ifAvailable: true }, run);
                else startImport();
            } catch (cause) {
                if (!signal.aborted) {
                    error.textContent = cause.message;
                    error.hidden = false;
                }
            } finally {
                await importTask;
                if (relevanceProgress.message === preparing) relevanceProgress.message = '';
                controller = null;
                relevanceProgress.notify();
            }
        });
        window.addEventListener('pagehide', () => {
            clearTimeout(availabilityTimer);
            availabilityController?.abort();
            controller?.abort();
            if (!relevanceProgress.busy) return;
            relevanceAnalysis.armed = false;
            Object.assign(relevanceProgress, { stage: 'error', busy: false, uploading: false, percent: null, finished: Date.now(),
                message: 'Ожидание прервано при уходе со страницы. Проверьте статус задания в ADEO.' });
        });
        window.addEventListener('pageshow', event => {
            if (event.persisted) refreshReportAvailability();
        });
    }

    function installRelevanceStyles() {
        if (document.getElementById('adeo-relevance-styles')) return;
        const style = document.createElement('style');
        style.id = 'adeo-relevance-styles';
        style.textContent = `
            .adeo-auto-price { margin: 0; background: #edf2f7; color: #26394d; font: 15px/1.5 Arial, sans-serif; }
            .adeo-auto-price main { width: min(1120px, calc(100% - 32px)); margin: 32px auto; }
            .adeo-auto-price h1 { margin: 0 0 18px; font-size: clamp(24px, 4vw, 32px); }
            .adeo-auto-price-test { margin: 0; padding: 12px 24px; font-size: 18px; }
            .adeo-auto-price-settings { display: flex; flex-wrap: wrap; gap: 12px 20px; min-width: 0; margin: 16px 12px 0; padding: 12px; border: 1px solid #d8e0e8; border-radius: 6px; }
            .adeo-auto-price-settings legend { padding: 0 6px; font-weight: bold; }
            .adeo-auto-price-settings label { display: grid; gap: 4px; }
            .adeo-auto-price-actions { display: flex; flex: 1 0 100%; flex-wrap: wrap; gap: 8px 20px; }
            .adeo-auto-price-actions label { display: flex; align-items: center; gap: 6px; }
            .adeo-auto-price-actions input { accent-color: #28649a; }
            .adeo-auto-price-settings :is(select, input[type=date], input[type=number]) { box-sizing: border-box; width: 100%; min-height: 36px; padding: 4px 8px; border: 1px solid #afc3d6; border-radius: 4px; background: white; color: inherit; font: inherit; }
            .adeo-auto-price-marketability-settings { display: grid; flex-basis: 100%; gap: 6px; }
            .adeo-auto-price-marketability-settings label:has(input[type=checkbox]) { display: flex; align-items: center; gap: 6px; }
            .adeo-auto-price-markup { width: 120px; }
            .adeo-auto-price .adeo-file-info { display: grid; gap: 4px; min-width: 0; }
            .adeo-auto-price input[type=file] { max-width: 100%; }
            .adeo-auto-price-availability { margin: 0; padding: 0 24px 8px; color: #825019; }
            .adeo-auto-price-availability:empty { padding: 0; }
            .adeo-auto-price-availability:not(:empty) + .adeo-relevance-bar[data-stage=idle] { display: none; }
            .adeo-auto-price-import { padding-bottom: 14px; border-top: 1px solid #d8e0e8; }
            .adeo-auto-price-import-status { margin: 0; padding: 0 24px; overflow-wrap: anywhere; }
            .adeo-auto-price-import-results { padding: 14px 24px 0; }
            .adeo-auto-price-import-results .adeo-analysis-grid { margin-bottom: 12px; }
            .adeo-auto-price-import-errors p { margin: 8px 0; }
            .adeo-auto-price-import-errors details { margin-top: 8px; }
            .adeo-auto-price-import-errors li { overflow-wrap: anywhere; }
            .adeo-relevance #price-form { border: 1px solid #d8e0e8; border-radius: 6px; background: #f8fafc; color: #26394d; }
            .adeo-relevance .adeo-relevance-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 12px; }
            .adeo-relevance #price-form button, .adeo-relevance #submitButton { box-sizing: border-box; min-height: 36px; padding: 7px 14px; border: 1px solid #c4cdd7; border-radius: 4px; background: #fff; color: #26394d; font: 14px Arial, sans-serif; cursor: pointer; }
            .adeo-relevance #price-form button:hover:not(:disabled) { background: #eaf1f8; border-color: #8faac4; }
            .adeo-auto-price #price-form .adeo-auto-price-launch { background: #28649a; border-color: #28649a; color: white; }
            .adeo-auto-price #price-form .adeo-auto-price-launch:hover:not(:disabled) { background: #204f7b; }
            .adeo-relevance #submitButton { background: #28649a; border-color: #28649a; color: white; }
            .adeo-relevance #price-form :disabled { opacity: .5; cursor: default; }
            .adeo-relevance #price-form :focus-visible, .adeo-relevance-bar a:focus-visible { outline: 2px solid #3274b5; outline-offset: 3px; }
            .adeo-relevance .adeo-file-card { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin: 12px; padding: 24px; border: 2px dashed #afc3d6; border-radius: 6px; background: #fff; }
            .adeo-relevance .adeo-file-info { flex: 1; min-width: 180px; overflow-wrap: anywhere; }
            .adeo-relevance .adeo-file-name { font-weight: bold; margin-bottom: 5px; }
            .adeo-relevance .adeo-file-hint { color: #597086; font-size: 13px; }
            .adeo-relevance .adeo-file-error { color: #a52b27; padding: 0 12px; }
            .adeo-relevance .adeo-relevance-settings { padding: 16px 12px; border-top: 1px solid #d8e0e8; }
            .adeo-relevance .adeo-relevance-settings input:not([type=checkbox]) { box-sizing: border-box; max-width: 100%; width: 180px; padding: 6px 8px; border: 1px solid #c4cdd7; border-radius: 4px; }
            .adeo-relevance .adeo-relevance-settings label { display: inline-block; margin-right: 8px; }
            .adeo-relevance .adeo-relevance-settings input[type=checkbox] { accent-color: #28649a; }
            .adeo-relevance .adeo-relevance-settings .icheckbox_minimal { position: relative; box-sizing: border-box; width: 18px; height: 18px; background: white !important; border: 1px solid #8faac4; border-radius: 3px; }
            .adeo-relevance .adeo-relevance-settings .icheckbox_minimal:has(> .icheckbox_minimal) { border: 0; background: transparent !important; }
            .adeo-relevance .adeo-relevance-settings .icheckbox_minimal:has(> input:checked)::after { content: '✓'; position: absolute; inset: 0; color: #28649a; font: bold 16px/16px Arial, sans-serif; text-align: center; pointer-events: none; }
            .adeo-relevance .adeo-relevance-settings .icheckbox_minimal:focus-within { outline: 2px solid #3274b5; outline-offset: 2px; }
            .adeo-relevance [hidden], .adeo-relevance-bar [hidden], .adeo-relevance-drop[hidden] { display: none !important; }
            .adeo-relevance-bar { padding: 14px 24px; border-top: 1px solid #c4cdd7; background: #f8fafc; color: #26394d; font: 14px/1.45 Arial, sans-serif; }
            .adeo-relevance-bar[data-stage=error] { border-top-color: #cb625d; background: #fff6f5; }
            .adeo-relevance-bar[data-stage=done] { border-top-color: #91bfa5; background: #f1faf5; }
            .adeo-relevance-bar:is([data-analysis-phase=downloading], [data-analysis-phase=loading], [data-analysis-phase=reading], [data-analysis-phase=calculating]) { border-top-color: #c4cdd7; background: #f8fafc; }
            .adeo-relevance-bar[data-analysis-phase=error] { border-top-color: #cb625d; background: #fff6f5; }
            .adeo-relevance-head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
            .adeo-relevance-title { font-size: 16px; font-weight: bold; }
            .adeo-relevance-time, .adeo-relevance-steps { color: #597086; font-size: 12px; }
            .adeo-relevance-steps { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 8px; }
            .adeo-relevance-steps [aria-current=step] { color: #28649a; font-weight: bold; }
            .adeo-relevance-track { height: 6px; background: #dfe7ef; border-radius: 4px; overflow: hidden; margin: 8px 0; }
            .adeo-relevance-fill { height: 100%; background: #3274b5; transition: width .25s; }
            .adeo-relevance-track.adeo-indeterminate .adeo-relevance-fill { width: 28% !important; animation: adeo-relevance-wait 1.8s infinite ease-in-out; }
            .adeo-relevance-message { overflow-wrap: anywhere; max-height: 4.5em; overflow: auto; }
            .adeo-relevance-warning { color: #9b4331; }
            .adeo-result-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
            .adeo-relevance-links, .adeo-analysis-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
            .adeo-relevance-links a { display: inline-block; padding: 6px 12px; background: #28649a; color: white; border-radius: 4px; }
            .adeo-analysis-results { margin-top: 16px; border-top: 1px solid #d8e0e8; padding-top: 14px; }
            .adeo-analysis-results h3 { font: bold 16px/1.5 Arial, sans-serif; margin: 0 0 12px; overflow-wrap: anywhere; }
            .adeo-analysis-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
            .adeo-analysis-grid article { background: white; border: 1px solid #d8e0e8; border-radius: 5px; padding: 12px; min-width: 0; }
            .adeo-analysis-grid span { display: block; color: #597086; font-size: 13px; }
            .adeo-analysis-grid strong { display: block; font-size: 22px; margin-top: 6px; overflow-wrap: anywhere; }
            .adeo-analysis-meta { margin-top: 12px; color: #597086; font-size: 12px; overflow-wrap: anywhere; }
            .adeo-analysis-results details { margin-top: 12px; }
            .adeo-analysis-results summary { cursor: pointer; color: #9b4331; }
            .adeo-analysis-results ul { max-height: 220px; overflow: auto; padding-left: 24px; }
            .adeo-analysis-brands { color: #597086; overflow-wrap: anywhere; }
            .adeo-analysis-results .adeo-analysis-brands summary { color: #597086; }
            .adeo-analysis-brands p { margin: 8px 0 0; }
            .adeo-relevance-drop { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center; padding: 24px; background: #eaf2fcf2; outline: 3px dashed #3274b5; outline-offset: -16px; color: #244d7a; font: bold 24px/1.5 Arial, sans-serif; text-align: center; pointer-events: none; }
            @keyframes adeo-relevance-wait { from { transform: translateX(-100%); } to { transform: translateX(460%); } }
            @media (prefers-reduced-motion: reduce) { .adeo-relevance-track.adeo-indeterminate .adeo-relevance-fill { animation: none; } }
            @media (max-width: 600px) { .adeo-relevance-bar { padding: 12px; } .adeo-relevance .adeo-file-card { padding: 16px; } }
        `;
        document.head.append(style);
        document.body.classList.add('adeo-relevance');
    }

    function mountRelevanceProgress(anchor, syncControls, idleMessage) {
        const element = (tag, className, text = '') => {
            const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
        };
        const bar = element('section', 'adeo-relevance-bar');
        bar.setAttribute('aria-label', 'Ход анализа прайса');
        const head = element('div', 'adeo-relevance-head');
        const title = element('div', 'adeo-relevance-title'); title.setAttribute('role', 'status');
        const time = element('div', 'adeo-relevance-time'); head.append(title, time);
        const steps = element('div', 'adeo-relevance-steps');
        ['Отправка файла', 'Ожидание', 'Обработка строк', 'Подготовка файла', 'Анализ Excel', 'Готово'].forEach((text, i) => steps.append(element('span', '', `${i + 1}. ${text}`)));
        const track = element('div', 'adeo-relevance-track'); track.setAttribute('role', 'progressbar');
        track.setAttribute('aria-label', 'Прогресс текущего этапа'); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100');
        const fill = element('div', 'adeo-relevance-fill'); track.append(fill);
        const message = element('div', 'adeo-relevance-message');
        const warning = element('div', 'adeo-relevance-warning'); warning.setAttribute('role', 'status');
        const links = element('div', 'adeo-relevance-links');
        const actions = element('div', 'adeo-analysis-actions');
        const analyze = createButton('Проанализировать прошлый результат', () => void startRelevanceAnalysis(), 'adeo-analysis-start');
        const cancel = createButton('Остановить анализ', () => stopRelevanceAnalysis('Анализ остановлен. Excel можно скачать или проанализировать повторно.'), 'adeo-analysis-cancel');
        actions.append(analyze, cancel);
        const resultActions = element('div', 'adeo-result-actions'); resultActions.append(links, actions);
        const results = element('div', 'adeo-analysis-results'); results.hidden = true;
        bar.append(head, steps, track, message, warning, resultActions, results); anchor.after(bar);
        const state = relevanceProgress;
        const titles = { idle: 'Готово к проверке', uploading: 'Отправка файла', queued: 'Ожидание обработки',
            processing: 'Обработка строк', preparing: 'Подготовка результата', done: 'Файл сформирован', error: 'Ошибка проверки', unknown: 'Статус проверки' };
        let renderedResult = null;
        function renderResult(data) {
            if (renderedResult === data) return;
            renderedResult = data; results.replaceChildren(); results.hidden = !data;
            if (!data) return;
            const heading = element('h3', '', relevanceAnalysis.sourceName ? `Результаты анализа: ${relevanceAnalysis.sourceName}` : 'Результаты анализа предыдущего файла');
            const grid = element('div', 'adeo-analysis-grid');
            const integer = value => new Intl.NumberFormat('ru-RU').format(BigInt(value));
            for (const [label, value] of [
                ['Сумма, руб.', `${integer(data.result.rub_sum)} ₽`],
                ['Заказали у него', integer(data.result.ordered_from_supplier)],
                ['Всего заказ', integer(data.result.total_orders)],
                ['Средний %', data.result.average_percent === null ? 'Нет данных' : `${data.result.average_percent.replace('.', ',')}%`],
                ['Максимум, руб.', `${integer(data.result.maximum_rub)} ₽`]
            ]) {
                const article = element('article', ''); article.append(element('span', '', label), element('strong', '', value)); grid.append(article);
            }
            const meta = data.meta;
            const columns = meta.detected_columns;
            const description = element('div', 'adeo-analysis-meta', `Лист: ${meta.sheet_name} · Обработано строк: ${integer(meta.processed_rows)} · Пропущено строк: ${integer(meta.skipped_rows)} · Наличие: D · Цена: E · Заказы: ${columns.orders} · Мин. цена: ${columns.minimum_order_price}`);
            results.append(heading, grid, description);
            if (data.errors?.length) {
                const brands = element('details', 'adeo-analysis-brands');
                brands.append(element('summary', '', `Неизвестные бренды: ${integer(meta.unprocessed_brand_count)}`));
                data.errors.forEach(item => brands.append(element('p', '', item.brands.join(', '))));
                results.append(brands);
            }
            if (meta.warning_count) {
                const details = element('details', 'adeo-analysis-warnings');
                details.append(element('summary', '', `Предупреждений: ${integer(meta.warning_count)}${meta.warning_count > data.warnings.length ? ` · показаны первые ${data.warnings.length}` : ''}`));
                const list = element('ul', '');
                data.warnings.forEach(item => list.append(element('li', '', `Строка ${item.row}, ${item.field}: ${item.reason}`)));
                details.append(list); results.append(details);
            }
        }
        function render() {
            bar.dataset.stage = state.stage;
            const analysis = relevanceAnalysis;
            const local = analysis.revision === state.revision && state.stage === 'done';
            const active = local && relevanceAnalysisRunning();
            const showAnalysis = local && analysis.phase !== 'idle';
            const percent = showAnalysis ? analysis.percent : state.percent;
            const oldResult = local && state.revision === 0 && analysis.phase === 'idle';
            const percentage = percent === null ? '' : ` · ${Math.floor(percent)}%${showAnalysis || state.stage === 'processing' ? ' строк' : ' передано'}`;
            const analysisTitles = { downloading: 'Получение Excel для анализа', loading: 'Подготовка анализа', reading: 'Чтение Excel', calculating: 'Анализ строк', done: 'Анализ завершён', error: 'Анализ не завершён' };
            const titleText = `${showAnalysis ? analysisTitles[analysis.phase] : oldResult ? 'Предыдущий результат готов' : titles[state.stage]}${percentage}`;
            bar.dataset.analysisPhase = analysis.phase;
            if (title.textContent !== titleText) title.textContent = titleText;
            message.textContent = showAnalysis ? analysis.message : oldResult ? 'Доступен результат прошлого запуска. Можно скачать или проанализировать его. Новый файл будет проанализирован автоматически после формирования.' : state.message || idleMessage;
            warning.textContent = state.warning;
            track.hidden = !state.busy && !active;
            track.classList.toggle('adeo-indeterminate', percent === null);
            fill.style.width = `${percent ?? 0}%`;
            if (percent === null) track.removeAttribute('aria-valuenow');
            else track.setAttribute('aria-valuenow', String(Math.floor(percent)));
            track.setAttribute('aria-valuetext', titleText);
            const index = active ? 4 : state.stage === 'done' ? (showAnalysis && analysis.phase === 'error' ? 4 : 5) : ['uploading', 'queued', 'processing', 'preparing'].indexOf(state.stage);
            Array.from(steps.children).forEach((step, i) => {
                if (i === index) step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current');
            });
            links.replaceChildren(...state.links.map(link => {
                const a = element('a', '', link.text);
                a.href = local && analysis.blobUrl && analysis.source === link.href ? analysis.blobUrl : link.href;
                if (a.href === analysis.blobUrl) a.download = analysis.fileName;
                return a;
            }));
            analyze.hidden = state.stage !== 'done' || state.busy || active || !state.links.length;
            analyze.textContent = analysis.phase === 'idle' ? (state.revision === 0 ? 'Проанализировать прошлый результат' : 'Проанализировать результат') : 'Повторить анализ';
            cancel.hidden = !active;
            actions.hidden = analyze.hidden && cancel.hidden;
            resultActions.hidden = !state.links.length && actions.hidden;
            renderResult(local ? analysis.result : null);
            syncControls(); updateTime();
        }
        function updateTime() {
            const analysis = relevanceAnalysis;
            const total = state.started ? `Время формирования: ${Math.floor(((state.finished ?? Date.now()) - state.started) / 1000)} с` : '';
            const local = analysis.started && state.revision === analysis.revision ? `Анализ: ${Math.floor(((analysis.finished ?? Date.now()) - analysis.started) / 1000)} с` : '';
            time.textContent = [total, local].filter(Boolean).join(' · ');
        }
        state.notify = render;
        let timer = setInterval(updateTime, 1000);
        window.addEventListener('pagehide', event => {
            clearInterval(timer);
            if (relevanceAnalysisRunning()) stopRelevanceAnalysis('Анализ прерван при уходе со страницы. Его можно запустить повторно.');
            if (!event.persisted && relevanceAnalysis.blobUrl) { URL.revokeObjectURL(relevanceAnalysis.blobUrl); relevanceAnalysis.blobUrl = ''; }
        });
        window.addEventListener('pageshow', event => {
            if (!event.persisted) return;
            timer = setInterval(updateTime, 1000); render();
        });
    }

    function enhancePriceRelevance() {
        const form = document.querySelector('#price-form');
        const input = form?.querySelector('input[type=file][name=price]');
        const submit = form?.querySelector('#submitButton');
        const status = document.querySelector('#status');
        if (!form || !input || !submit || !status || form.dataset.adeoRelevance) return;
        form.dataset.adeoRelevance = 'true';
        installRelevanceStyles();
        const element = (tag, className, text = '') => {
            const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
        };
        const settings = element('div', 'adeo-relevance-settings');
        settings.id = 'adeo-relevance-settings'; settings.hidden = true;
        // Перемещаем исходные поля вместе с обёртками iCheck и обработчиками сайта.
        const fileGroup = input.closest('.form-group');
        input.hidden = true;
        const card = element('div', 'adeo-file-card');
        const info = element('div', 'adeo-file-info');
        const fileName = element('div', 'adeo-file-name', 'Выберите прайс для анализа');
        const fileHint = element('div', 'adeo-file-hint', 'XLS или XLSX · Можно перетащить файл в любое место страницы');
        info.append(fileName, fileHint);
        const choose = createButton('Выбрать файл', () => input.click(), 'adeo-file-choose');
        const remove = createButton('Убрать', () => { input.value = ''; input.dispatchEvent(new Event('change', { bubbles: true })); }, 'adeo-file-remove');
        card.append(input, choose, info, remove);
        fileGroup?.remove();
        const tools = element('div', 'adeo-relevance-tools');
        const toggle = createButton('Настройки', () => {
            settings.hidden = !settings.hidden;
            toggle.setAttribute('aria-expanded', String(!settings.hidden));
        }, 'adeo-relevance-toggle');
        toggle.setAttribute('aria-controls', settings.id); toggle.setAttribute('aria-expanded', 'false');
        tools.append(submit, toggle);
        settings.append(...Array.from(form.children));
        settings.querySelectorAll('input[name]').forEach(field => {
            if (!field.id) field.id = `adeo-relevance-${field.name}`;
            const label = field.closest('.form-group')?.querySelector('label');
            if (label) label.htmlFor = field.id;
        });
        const error = element('p', 'adeo-file-error'); error.setAttribute('role', 'alert'); error.hidden = true;
        form.append(card, error, tools, settings);
        const overlay = element('div', 'adeo-relevance-drop', 'Отпустите один файл XLS или XLSX для выбора');
        overlay.hidden = true; document.body.append(overlay);

        const originalStatusBox = status.closest('.container-fluid');
        if (originalStatusBox && !originalStatusBox.contains(form)) originalStatusBox.hidden = true;
        else status.hidden = true;

        const state = relevanceProgress;
        function showError(text) { error.textContent = text; error.hidden = !text; }
        function updateFile() {
            const file = input.files[0];
            fileName.textContent = file?.name || 'Выберите прайс для анализа';
            fileHint.textContent = file ? `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(file.size / 1024)} КБ · XLS или XLSX` : 'XLS или XLSX · Можно перетащить файл в любое место страницы';
            remove.hidden = !file;
            choose.textContent = file ? 'Заменить файл' : 'Выбрать файл';
            showError(file && !isRelevanceFile(file) ? 'Нужен непустой файл в формате XLS или XLSX.' : '');
            syncControls();
        }
        function syncControls() {
            const locked = state.busy || state.uploading || relevanceAnalysisRunning();
            const disabled = locked || !isRelevanceFile(input.files[0]);
            if (submit.disabled !== disabled) submit.disabled = disabled;
            choose.disabled = remove.disabled = input.disabled = locked;
        }
        mountRelevanceProgress(tools, syncControls, 'Выберите файл и нажмите «Сформировать».');
        if (!state.message) applyRelevanceMessage(status.innerHTML, submit.disabled);
        input.addEventListener('change', updateFile);
        form.addEventListener('submit', event => {
            if (state.busy || relevanceAnalysisRunning() || !isRelevanceFile(input.files[0])) {
                event.preventDefault(); event.stopImmediatePropagation();
                if (!state.busy) showError('Выберите непустой файл XLS или XLSX.');
            }
        }, true);
        // Штатный опрос может менять disabled: блокировка учитывает также локальную отправку.
        const observer = new MutationObserver(syncControls);
        observer.observe(submit, { attributes: true, attributeFilter: ['disabled'] });
        let dragDepth = 0;
        const hasFiles = event => Array.from(event.dataTransfer?.types ?? []).includes('Files');
        document.addEventListener('dragenter', event => {
            if (!hasFiles(event)) return;
            event.preventDefault(); dragDepth++;
            overlay.textContent = state.busy || relevanceAnalysisRunning() ? 'Дождитесь завершения текущей проверки' : 'Отпустите один файл XLS или XLSX для выбора';
            overlay.hidden = false;
        });
        document.addEventListener('dragover', event => {
            if (!hasFiles(event)) return;
            event.preventDefault(); event.dataTransfer.dropEffect = state.busy || relevanceAnalysisRunning() ? 'none' : 'copy';
        });
        const clearDrag = () => { dragDepth = 0; overlay.hidden = true; };
        document.addEventListener('dragleave', event => { if (hasFiles(event) && --dragDepth <= 0) clearDrag(); });
        document.addEventListener('drop', event => {
            if (!hasFiles(event)) return;
            event.preventDefault(); clearDrag();
            if (state.busy || relevanceAnalysisRunning()) return;
            const files = event.dataTransfer.files;
            if (files.length !== 1 || !isRelevanceFile(files[0])) { showError('Перетащите один непустой файл XLS или XLSX.'); return; }
            try {
                input.files = files;
                input.dispatchEvent(new Event('change', { bubbles: true }));
            } catch { showError('Браузер не смог принять файл. Используйте кнопку «Выбрать файл».'); }
        });
        window.addEventListener('blur', clearDrag);
        document.addEventListener('dragend', clearDrag);
        window.addEventListener('pagehide', () => { observer.disconnect(); clearDrag(); });
        window.addEventListener('pageshow', event => {
            if (event.persisted) observer.observe(submit, { attributes: true, attributeFilter: ['disabled'] });
        });
        updateFile(); state.notify();
    }

    function updateTextStyle(element) {
        const text = element.textContent.trim().toLowerCase();
        element.style.fontWeight = 'bold';
        if (text.includes('уже идет импорт')) element.style.color = 'red';
        else if (text.includes('задание в очереди')) element.style.color = '#CC9933';
        else if (text.includes('импорт окончен')) element.style.color = 'green';
        else element.style.color = '';
    }

    function initCompareMode() {
        observePage(() => {
            document.querySelectorAll('.job-status').forEach(updateTextStyle);
            setFileAcceptAttribute('input[type="file"][name="upfile"][id="pricefile"]');
        });
    }

    function getCellText(row, column, partial = false) {
        const operator = partial ? '*=' : '=';
        return row.querySelector(`td[aria-describedby${operator}"${column}"]`)?.textContent.trim() ?? '';
    }

    function initImportStatistics() {
        observePage(() => {
            document.querySelectorAll('tr.jqgrow > td[aria-describedby$="_sklad"]').forEach(cell => {
                const column = cell.getAttribute('aria-describedby');
                const id = getCellText(cell.parentElement, column.replace(/_sklad$/, '_supplier_id'));
                const supplier = cell.textContent.trim();
                const fileNumber = supplier.match(/\/\s*(\d+)\s*$/)?.[1];
                if (!/^\d+$/.test(id) || !fileNumber) return;
                const href = `https://admin.adeo.pro/admin/supplier/price/compare/${id}/${fileNumber}`;
                let link = cell.querySelector('a.adeo-istat-compare');
                if (!link) {
                    link = document.createElement('a');
                    link.className = 'adeo-istat-compare';
                    link.textContent = supplier;
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                    link.title = 'Открыть сравнение прайса в новой вкладке';
                    // Открытие ссылки не должно переключать выбранную строку jqGrid.
                    link.addEventListener('click', event => event.stopPropagation());
                    cell.replaceChildren(link);
                }
                if (link.getAttribute('href') !== href) link.setAttribute('href', href);
            });
        });
    }

    function getSupplierKey(row) {
        return `${getCellText(row, 'supplier_price_unique_supplier_cella')}/${getCellText(row, 'supplier_price_unique_n_file')}`;
    }

    function getSupplierRows() {
        return Array.from(document.querySelectorAll('tr.jqgrow')).filter(row =>
            row.querySelector('td[aria-describedby="supplier_price_unique_supplier_cella"]') &&
            row.querySelector('td[aria-describedby="supplier_price_unique_n_file"]')
        );
    }

    async function copyText(text, button) {
        try {
            await navigator.clipboard.writeText(text);
            if (button) showCopyFeedback(button);
            console.log('[ADEO] Данные скопированы в буфер обмена');
        } catch (error) {
            console.error('[ADEO] Ошибка копирования:', error);
            alert('Не удалось скопировать данные. Проверьте разрешение браузера на доступ к буферу обмена.');
        }
    }

    function showCopyFeedback(button) {
        const previous = copyFeedback.get(button);
        if (previous) clearTimeout(previous.timer);
        const originalText = previous?.originalText ?? button.textContent;
        const originalWidth = previous?.originalWidth ?? button.style.minWidth;
        button.style.minWidth = `${button.getBoundingClientRect().width}px`;
        button.textContent = 'Скопировано ✓';
        button.classList.add('adeo-copied');
        const timer = setTimeout(() => {
            button.textContent = originalText;
            button.style.minWidth = originalWidth;
            button.classList.remove('adeo-copied');
            copyFeedback.delete(button);
        }, 1800);
        copyFeedback.set(button, { originalText, originalWidth, timer });
    }

    function createButton(text, onClick, className) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = text;
        button.style.cursor = 'pointer';
        button.addEventListener('click', onClick);
        return button;
    }

    function renderSrokiModal(keys, dictionary) {
        if (document.querySelector('.adeo-sroki-overlay')) return;
        const overlay = document.createElement('div');
        overlay.className = 'adeo-sroki-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', inset: '0', backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: '9999'
        });
        const modal = document.createElement('div');
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-label', 'Сроки');
        Object.assign(modal.style, {
            position: 'relative', backgroundColor: '#fff', color: '#333', padding: '20px',
            borderRadius: '6px', maxWidth: '600px', width: '90%', maxHeight: '90vh',
            overflowY: 'auto', boxSizing: 'border-box'
        });
        const title = document.createElement('h2');
        title.textContent = 'Сроки';
        const table = document.createElement('table');
        Object.assign(table.style, { borderCollapse: 'collapse', width: '100%' });
        const header = table.createTHead().insertRow();
        ['Cella/Склад', 'Срок'].forEach(text => {
            const cell = document.createElement('th');
            cell.textContent = text;
            header.appendChild(cell);
        });
        const body = table.createTBody();
        keys.forEach(key => {
            const row = body.insertRow();
            row.insertCell().textContent = key;
            row.insertCell().textContent = dictionary[key] ?? '—';
        });
        table.querySelectorAll('th, td').forEach(cell => {
            Object.assign(cell.style, { border: '1px solid #ccc', padding: '8px' });
        });
        const previousFocus = document.activeElement;
        function closeModal() {
            overlay.remove();
            document.removeEventListener('keydown', handleEscape);
            previousFocus?.focus();
        }
        function handleEscape(event) {
            if (event.key === 'Escape') closeModal();
        }
        const closeButton = createButton('×', closeModal, 'adeo-close-modal');
        closeButton.setAttribute('aria-label', 'Закрыть');
        Object.assign(closeButton.style, { position: 'absolute', top: '10px', right: '10px', fontSize: '24px' });
        modal.append(title, table, closeButton);
        overlay.appendChild(modal);
        overlay.addEventListener('click', event => {
            if (event.target === overlay) closeModal();
        });
        document.addEventListener('keydown', handleEscape);
        document.body.appendChild(overlay);
        closeButton.focus();
    }

    async function showSrokiModal(event) {
        const button = event.currentTarget;
        if (document.querySelector('.adeo-sroki-overlay') || button.disabled) return;
        button.disabled = true;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            const keys = getSupplierRows().map(getSupplierKey);
            const response = await fetch(SROKI_URL, { signal: controller.signal });
            if (!response.ok) throw new Error(`Ошибка сервера: ${response.status}`);
            const dictionary = await response.json();
            if (!dictionary || typeof dictionary !== 'object' || Array.isArray(dictionary)) {
                throw new Error('Сервер вернул некорректный словарь сроков');
            }
            renderSrokiModal(keys, dictionary);
        } catch (error) {
            console.error('[ADEO] Не удалось загрузить сроки:', error);
            alert('Не удалось загрузить сроки с сервера. Подробности в консоли (F12 → Console).');
        } finally {
            clearTimeout(timeout);
            button.disabled = false;
        }
    }

    function openNewPrice() {
        const match = window.location.pathname.match(/^\/admin\/supplier\/price\/compare\/([^/]+)\/([^/]+)\/?$/);
        if (match) window.location.href = `/admin/supplier/price/comparemode/${match[1]}/${match[2]}`;
    }

    function installCompareStyles() {
        document.body.classList.add('adeo-compare');
        if (document.querySelector('#adeo-compare-styles')) return;
        const style = document.createElement('style');
        style.id = 'adeo-compare-styles';
        style.textContent = `
            .adeo-compare .adeo-controls { border: 1px solid #d8e0e8; border-radius: 6px; background: #f8fafc; margin-bottom: 14px; }
            .adeo-compare .adeo-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px; }
            .adeo-compare .adeo-toolbar > button { box-sizing: border-box; height: 36px; padding: 0 14px; border: 1px solid #c4cdd7; border-radius: 4px; background: #fff; color: #26394d; font-size: 14px; white-space: nowrap; }
            .adeo-compare .adeo-toolbar > button:hover:not(:disabled) { background: #eaf1f8; border-color: #8faac4; }
            .adeo-compare .adeo-toolbar > button:focus-visible { outline: 2px solid #3274b5; outline-offset: 2px; }
            .adeo-compare .adeo-toolbar > button:disabled { opacity: .5; cursor: default; }
            .adeo-compare .adeo-toolbar .adeo-new-price { background: #28649a; border-color: #28649a; color: #fff; }
            .adeo-compare .adeo-toolbar .adeo-new-price:hover { background: #20527f; color: #fff; }
            .adeo-compare .adeo-toolbar .adeo-hide-reg[aria-checked="true"] { background: #e6f3ec; border-color: #91bfa5; color: #225b3b; }
            .adeo-compare .adeo-hide-reg::before { content: '○'; margin-right: 6px; }
            .adeo-compare .adeo-hide-reg[aria-checked="true"]::before { content: '✓'; }
            .adeo-compare .adeo-row-count { margin-left: auto; color: #4b5d70; font-size: 13px; }
            .adeo-compare .adeo-settings-body { margin: 0; padding: 0 12px 8px; border-top: 1px solid #d8e0e8; }
            .adeo-compare .adeo-settings-body[hidden] { display: none; }
            .adeo-compare #supplier_price_unique > tbody > tr.adeo-row-even > td { background: #fff; }
            .adeo-compare #supplier_price_unique > tbody > tr.adeo-row-odd > td { background: #f4f7fa; }
            .adeo-compare #supplier_price_unique > tbody > tr.jqgrow:hover > td { background: #eaf2fc; }
            .adeo-compare #supplier_price_unique > tbody > tr.adeo-expanded > td { background: #dceafa; border-bottom-color: #9ebddc; }
            .adeo-compare #supplier_price_unique > tbody > tr.adeo-expanded > td:first-child { box-shadow: inset 3px 0 #3274b5; }
            .adeo-compare .subgrid-data th.adeo-current-price { background: #e5effb; color: #244d7a; }
            .adeo-compare .subgrid-data th.adeo-compared-price { background: #e5f3ec; color: #245c42; }
            .adeo-compare .adeo-price-label { display: block; font-weight: bold; line-height: 18px; }
            .adeo-compare .subgrid-data th.adeo-current-price, .adeo-compare .subgrid-data th.adeo-compared-price { height: auto; padding: 3px 6px; }
            .adeo-compare .subgrid-data td.adeo-price-lower { background: #e7f4eb; color: #21613b; }
            .adeo-compare .subgrid-data td.adeo-price-higher { background: #fceceb; color: #963c36; }
            .adeo-compare .subgrid-data td.adeo-price-equal { color: #596575; }
            .adeo-compare button.adeo-copied { color: #21613b !important; background: #e7f4eb !important; }
            .adeo-compare .adeo-copy-button, .adeo-compare .adeo-copy-header-button { box-sizing: border-box; }
        `;
        document.head.appendChild(style);
    }

    function addToolbarButtons() {
        const target = document.querySelector('.form-horizontal');
        if (!target) return;
        installCompareStyles();
        if (target.querySelector('.adeo-toolbar[data-adeo-controls]')) return;
        const toolbar = target.querySelector('.adeo-toolbar') ?? document.createElement('div');
        toolbar.replaceChildren();
        toolbar.className = 'adeo-toolbar';
        toolbar.dataset.adeoControls = 'true';
        target.classList.add('adeo-controls');
        const settings = target.querySelector('fieldset');
        const settingsButton = createButton('Настройки', () => {
            settings.hidden = !settings.hidden;
            settingsButton.setAttribute('aria-expanded', String(!settings.hidden));
        }, 'adeo-settings-toggle');
        settingsButton.disabled = !settings;
        if (settings) {
            settings.hidden = true;
            settings.classList.add('adeo-settings-body');
            if (!settings.id) settings.id = 'adeo-compare-settings';
            settingsButton.setAttribute('aria-controls', settings.id);
            settingsButton.setAttribute('aria-expanded', String(!settings.hidden));
        }
        const regToggle = createButton('Скрывать Reg', () => {
            hideReg = !hideReg;
            regToggle.setAttribute('aria-checked', String(hideReg));
            filterSupplierRows();
            syncSupplierScrollHeight();
            updateSupplierPresentation();
        }, 'adeo-hide-reg');
        regToggle.setAttribute('role', 'switch');
        regToggle.setAttribute('aria-checked', String(hideReg));
        const counter = document.createElement('span');
        counter.className = 'adeo-row-count';
        counter.setAttribute('aria-live', 'polite');
        counter.title = 'Счётчик загруженных строк поставщиков';
        toolbar.append(
            createButton('Новый прайс', openNewPrice, 'adeo-new-price'),
            createButton('Сроки', showSrokiModal, 'adeo-sroki'),
            settingsButton,
            createButton('Свернуть все детализации', collapseAllDetails, 'adeo-collapse-all'),
            regToggle, counter
        );
        target.prepend(toolbar);
    }

    function isSupplierExpanded(row) {
        return Boolean(row.querySelector('.sgexpanded'));
    }

    function collapseAllDetails() {
        const table = document.querySelector('#supplier_price_unique');
        getSupplierRows().filter(isSupplierExpanded).forEach(row => {
            if (table && window.jQuery?.fn?.jqGrid) {
                window.jQuery(table).jqGrid('collapseSubGridRow', row.id);
            } else {
                row.querySelector('.sgexpanded')?.click();
            }
            const details = row.nextElementSibling;
            if (details && filteredRowDisplays.has(details)) {
                filteredRowDisplays.set(details, details.style.display);
            }
        });
        updateSupplierPresentation();
        syncSupplierScrollHeight();
    }

    function updateSupplierPresentation() {
        const rows = getSupplierRows();
        let visible = 0;
        rows.forEach(row => {
            const shown = row.style.display !== 'none';
            row.classList.toggle('adeo-row-odd', shown && visible % 2 === 1);
            row.classList.toggle('adeo-row-even', shown && visible % 2 === 0);
            row.classList.toggle('adeo-expanded', isSupplierExpanded(row));
            if (shown) visible++;
        });
        const hiddenReg = rows.filter(row => filteredRowDisplays.has(row) &&
            getCellText(row, 'supplier_price_unique_supplier_cella').includes('Reg')).length;
        const counter = document.querySelector('.adeo-row-count');
        const text = `Показано: ${visible} · Скрыто Reg: ${hiddenReg}`;
        if (counter && counter.textContent !== text) counter.textContent = text;
        const collapseButton = document.querySelector('.adeo-collapse-all');
        if (collapseButton) collapseButton.disabled = !rows.some(isSupplierExpanded);
    }

    function activateCheckboxWithText(text) {
        document.querySelectorAll('.checkbox label').forEach(label => {
            if (label.textContent.trim() === text) setCheckboxOnce(label.querySelector('input[type="checkbox"]'), true, true);
        });
    }

    function prepareInitialCompareRequest() {
        if (!/^\/admin\/supplier\/price\/compare\/[^/]+\/[^/]+\/?$/.test(window.location.pathname) ||
            document.readyState !== 'loading' || typeof XMLHttpRequest === 'undefined') return;
        const prototype = XMLHttpRequest.prototype;
        const originalOpen = prototype.open;
        const originalSend = prototype.send;
        const requests = new WeakMap();
        let pending = true;

        function openInitialRequest(method, url, ...args) {
            requests.delete(this);
            const result = originalOpen.call(this, method, url, ...args);
            const address = new URL(url, window.location.href);
            requests.set(this, { method: String(method).toUpperCase(), address });
            return result;
        }

        function sendInitialRequest(body) {
            const request = requests.get(this);
            if (pending && request?.method === 'POST' &&
                request.address.origin === window.location.origin &&
                request.address.pathname === window.location.pathname &&
                (body == null || typeof body === 'string' || body instanceof URLSearchParams)) {
                // Меняем только первый запрос основной таблицы, до его отправки на сервер.
                const params = new URLSearchParams(body ?? '');
                const input = document.querySelector('input[name="remains"]');
                params.set('settings[remains]', input?.value || 'on');
                body = params.toString();
                activateCheckboxWithText('Остаток');
                pending = false;
                // Последующие запросы полностью управляются действиями пользователя и самой панелью.
                if (prototype.open === openInitialRequest) prototype.open = originalOpen;
                if (prototype.send === sendInitialRequest) prototype.send = originalSend;
            }
            return originalSend.call(this, body);
        }

        prototype.open = openInitialRequest;
        prototype.send = sendInitialRequest;
    }

    function installLoadingStyles() {
        if (document.querySelector('#adeo-loading-styles')) return;
        const style = document.createElement('style');
        style.id = 'adeo-loading-styles';
        style.textContent = `
            .ui-jqgrid .loading.adeo-loading { left: 50%; top: 45%; transform: translateX(-50%); width: max-content; max-width: calc(100% - 24px); box-sizing: border-box; padding: 12px 16px; border: 1px solid #c7d5e4; border-radius: 6px; background: #fff; color: #294760; box-shadow: 0 3px 14px #18334d20; font: 14px/1.5 Arial, sans-serif; white-space: normal; text-align: center; z-index: 1001; }
            .adeo-loading::before { content: ''; display: inline-block; width: 14px; height: 14px; margin-right: 9px; vertical-align: -2px; border: 2px solid #d5e3ef; border-top-color: #3274b5; border-radius: 50%; animation: adeo-loading-spin .8s linear infinite; }
            .adeo-loading.adeo-loading-error { color: #963c36; border-color: #e3bdb9; }
            .adeo-loading.adeo-loading-error::before { display: none; }
            .adeo-loading-timer { margin-left: 7px; font-variant-numeric: tabular-nums; color: #63788a; }
            @keyframes adeo-loading-spin { to { transform: rotate(360deg); } }
            @media (prefers-reduced-motion: reduce) { .adeo-loading::before { animation: none; } }
        `;
        (document.head ?? document.documentElement).appendChild(style);
    }

    function findLoadingGrid(address, body) {
        if (address.origin !== window.location.origin) return null;
        const path = window.location.pathname.replace(/\/$/, '');
        if (address.pathname.replace(/\/$/, '') === path) return 'supplier_price_unique';
        const detailsPath = path.replace('/price/compare/', '/price/compare/list/');
        if (address.pathname.replace(/\/$/, '') !== detailsPath) return null;
        const params = typeof body === 'string' || body instanceof URLSearchParams ? new URLSearchParams(body) : null;
        const candidates = Array.from(document.querySelectorAll('.subgrid-data table.ui-jqgrid-btable'));
        const matching = candidates.filter(table => {
            const row = table.p?.postData?.row_id;
            if (!row || !params) return false;
            const keys = ['storage_id', 'cella_id', 'n_file', 'supplier_cella'].filter(key => row[key] != null && params.has(`row_id[${key}]`));
            return keys.length > 0 && keys.every(key => params.get(`row_id[${key}]`) === String(row[key]));
        });
        // Без однозначного соответствия не показываем запрос в чужой детализации.
        return matching.length === 1 ? matching[0].id :
            candidates.length === 1 && !candidates[0].p?.postData?.row_id ? candidates[0].id : null;
    }

    function renderLoadingState(state) {
        if (loadingRequests.get(state.gridId) !== state) return;
        const loader = document.getElementById(`load_${state.gridId}`);
        if (!loader) return;
        installLoadingStyles();
        loader.classList.add('adeo-loading');
        loader.classList.toggle('adeo-loading-error', state.stage === 'error' || state.stage === 'cancelled');
        loader.dataset.adeoStage = state.stage;
        loader.setAttribute('role', 'status');
        loader.setAttribute('aria-live', 'polite');
        let message = loader.querySelector('.adeo-loading-message');
        let timer = loader.querySelector('.adeo-loading-timer');
        if (!message || !timer) {
            message = document.createElement('span');
            message.className = 'adeo-loading-message';
            timer = document.createElement('span');
            timer.className = 'adeo-loading-timer';
            timer.setAttribute('aria-hidden', 'true');
            loader.replaceChildren(message, timer);
        }
        if (message.textContent !== state.message) message.textContent = state.message;
        const elapsed = ((state.finishedAt ?? performance.now()) - state.startedAt) / 1000;
        const time = `${elapsed.toFixed(1).replace('.', ',')} с`;
        if (timer.textContent !== time) timer.textContent = time;
        loader.style.display = 'block';
    }

    function trackLoadingRequest(xhr, gridId) {
        const previous = loadingRequests.get(gridId);
        if (previous) {
            clearInterval(previous.timer);
            if (previous.frame) cancelAnimationFrame(previous.frame);
        }
        const state = { gridId, startedAt: performance.now(), stage: 'waiting', message: 'Ожидание ответа сервера…' };
        loadingRequests.set(gridId, state);
        state.timer = setInterval(() => renderLoadingState(state), 100);
        renderLoadingState(state);

        function setLoadingStage(stage, message) {
            state.stage = stage;
            state.message = message;
            renderLoadingState(state);
        }

        function finishLoading(stage, message) {
            if (loadingRequests.get(gridId) !== state) return;
            clearInterval(state.timer);
            state.finishedAt = performance.now();
            setLoadingStage(stage, message);
            if (stage !== 'rendering') return;
            // Даём обработчику jqGrid заполнить таблицу и браузеру отрисовать результат.
            state.frame = requestAnimationFrame(() => {
                state.frame = requestAnimationFrame(() => {
                    if (loadingRequests.get(gridId) !== state) return;
                    const loader = document.getElementById(`load_${gridId}`);
                    if (loader) loader.style.display = 'none';
                    loadingRequests.delete(gridId);
                });
            });
        }

        xhr.addEventListener('readystatechange', () => {
            if (xhr.readyState === 2 || xhr.readyState === 3) setLoadingStage('receiving', 'Получение данных…');
            if (xhr.readyState === 4 && ((xhr.status >= 200 && xhr.status < 300) || xhr.status === 304)) {
                setLoadingStage('rendering', 'Формирование таблицы…');
            }
        }, { capture: true });
        xhr.addEventListener('progress', event => {
            if (state.finishedAt != null || state.stage === 'rendering') return;
            const percent = event.lengthComputable && event.total > 0
                ? ` ${Math.min(100, Math.round(event.loaded / event.total * 100))}%` : '';
            setLoadingStage('receiving', `Получение данных…${percent}`);
        });
        xhr.addEventListener('load', () => {
            if ((xhr.status >= 200 && xhr.status < 300) || xhr.status === 304) {
                finishLoading('rendering', 'Формирование таблицы…');
            } else {
                finishLoading('error', `Не удалось загрузить данные (HTTP ${xhr.status})`);
            }
        });
        xhr.addEventListener('error', () => finishLoading('error', 'Не удалось загрузить данные. Ошибка сети.'));
        xhr.addEventListener('timeout', () => finishLoading('error', 'Не удалось загрузить данные. Время ожидания истекло.'));
        xhr.addEventListener('abort', () => finishLoading('cancelled', 'Загрузка отменена.'));
        return state;
    }

    function installLoadingProgress() {
        if (!/^\/admin\/supplier\/price\/compare\/[^/]+\/[^/]+\/?$/.test(window.location.pathname) ||
            typeof XMLHttpRequest === 'undefined') return;
        const prototype = XMLHttpRequest.prototype;
        const originalOpen = prototype.open;
        const originalSend = prototype.send;
        const requests = new WeakMap();

        function openTrackedRequest(method, url, ...args) {
            requests.delete(this);
            const result = originalOpen.call(this, method, url, ...args);
            requests.set(this, { method: String(method).toUpperCase(), address: new URL(url, window.location.href) });
            return result;
        }

        function sendTrackedRequest(body) {
            const request = requests.get(this);
            const gridId = request?.method === 'POST' ? findLoadingGrid(request.address, body) : null;
            const state = gridId ? trackLoadingRequest(this, gridId) : null;
            try {
                return originalSend.call(this, body);
            } catch (error) {
                if (state) {
                    clearInterval(state.timer);
                    state.finishedAt = performance.now();
                    state.stage = 'error';
                    state.message = 'Не удалось отправить запрос.';
                    renderLoadingState(state);
                }
                throw error;
            }
        }

        prototype.open = openTrackedRequest;
        prototype.send = sendTrackedRequest;
        window.addEventListener('pagehide', () => {
            loadingRequests.forEach(state => {
                clearInterval(state.timer);
                if (state.frame) cancelAnimationFrame(state.frame);
                const loader = document.getElementById(`load_${state.gridId}`);
                if (loader) loader.style.display = 'none';
            });
            loadingRequests.clear();
        });
    }

    function updateDropdownValues(dropdown) {
        if (dropdown.dataset.adeoUpdated) return;
        const selectedValue = dropdown.value;
        const values = PAGE_SIZES.includes(Number(selectedValue))
            ? PAGE_SIZES : [...PAGE_SIZES, Number(selectedValue)].filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
        dropdown.replaceChildren();
        values.forEach(value => {
            const option = document.createElement('option');
            option.value = String(value);
            option.textContent = String(value);
            dropdown.appendChild(option);
        });
        dropdown.value = selectedValue;
        if (dropdown.selectedIndex < 0) dropdown.value = String(PAGE_SIZES[0]);
        dropdown.dataset.adeoUpdated = 'true';
    }

    function addCopyButtons() {
        getSupplierRows().forEach(row => {
            const fullname = row.querySelector('td[aria-describedby="supplier_price_unique_supplier_fullname"]');
            if (!fullname || row.querySelector('.adeo-copy-button')) return;
            const button = createButton('Скопировать в буфер', event => {
                // Данные читаем при нажатии, чтобы учитывать обновления таблицы.
                copyText(`${getSupplierKey(row)} (${getCellText(row, 'supplier_price_unique_cnt')}) ${getCellText(row, 'supplier_price_unique_prc_dup')}%`, event.currentTarget);
            }, 'adeo-copy-button');
            Object.assign(button.style, { marginLeft: '10px', float: 'right' });
            // В jqGrid действует white-space: pre: перенос в названии иначе опускает кнопку ниже.
            Object.assign(fullname.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center' });
            fullname.appendChild(button);
        });
    }

    function filterSupplierRows() {
        getSupplierRows().forEach(row => {
            const hidden = hideReg && getCellText(row, 'supplier_price_unique_supplier_cella').includes('Reg');
            const targets = [row];
            // Развёрнутая детализация jqGrid находится в отдельной строке сразу после поставщика.
            if (row.nextElementSibling?.classList.contains('ui-subgrid')) targets.push(row.nextElementSibling);
            targets.forEach(target => {
                if (hidden) {
                    if (!filteredRowDisplays.has(target)) filteredRowDisplays.set(target, target.style.display);
                    target.style.display = 'none';
                } else if (filteredRowDisplays.has(target)) {
                    target.style.display = filteredRowDisplays.get(target);
                    filteredRowDisplays.delete(target);
                }
            });
        });
    }

    function syncSupplierScrollHeight() {
        const table = document.querySelector('#supplier_price_unique');
        const wrapper = table?.parentElement;
        if (!wrapper?.parentElement?.classList.contains('ui-jqgrid-bdiv')) return;
        const rows = getSupplierRows();
        const records = Number(table.p?.records);
        if (!table.p || (Number.isFinite(records) && rows.length >= records)) {
            // При полной загрузке резерв виртуальной прокрутки больше не нужен.
            wrapper.style.height = 'auto';
            return;
        }
        if (!Number.isFinite(records) || records <= 0) return;
        // До завершения загрузки сохраняем резерв для записей, которых ещё нет в DOM.
        const rowHeight = table.grid?.prevRowHeight || rows.find(row => row.offsetHeight > 0)?.offsetHeight ||
            supplierRowHeights.get(table) || parseFloat(wrapper.style.height) / records;
        if (!Number.isFinite(rowHeight) || rowHeight <= 0) return;
        supplierRowHeights.set(table, rowHeight);
        const hiddenCount = rows.filter(row => filteredRowDisplays.has(row)).length;
        wrapper.style.height = `${Math.max(0, records - hiddenCount) * rowHeight}px`;
    }

    function copyIntersections(header, button) {
        const table = header.closest('.subgrid-data')?.querySelector('table.ui-jqgrid-btable');
        if (!table) return;
        // Точные окончания имён исключают путаницу между колонками p_* и cp_*.
        const columns = ['pn_clean', 'cbg_group_code', '', 'p_pn_draft', 'p_pn_price_desc',
            'p_cost_eval', 'p_remains', 'cp_pn_draft', 'cp_pn_price_desc', 'cp_cost_eval',
            'cp_cost_eval_diff', 'cp_remains'];
        const lines = Array.from(table.querySelectorAll('tr.jqgrow'), row => columns.map(column => {
            if (!column) return '';
            const cell = row.querySelector(`td[aria-describedby$="_${column}"]`);
            const difference = cell && priceDifferenceValues.get(cell);
            const text = difference && cell.textContent === difference.formatted ? difference.raw : cell?.textContent ?? '';
            return text.trim().replace(/[\t\r\n]+/g, ' ');
        }).join('\t'));
        // Сохраняем завершающие табуляции: пустые последние столбцы нужны при вставке в Excel.
        copyText(lines.join('\n'), button);
    }

    function addCopyHeaderButtons() {
        document.querySelectorAll('th[role="columnheader"][colspan="3"]').forEach(header => {
            if (!header.closest('.subgrid-data') || !header.textContent.includes('Топ 500 позиций') ||
                header.querySelector('.adeo-copy-header-button')) return;
            const button = createButton('Копировать пересечения', event => copyIntersections(header, event.currentTarget), 'adeo-copy-header-button');
            Object.assign(button.style, { padding: '5px 10px', backgroundColor: 'white', border: '1px solid #333', borderRadius: '4px', color: '#333', fontWeight: 'bold' });
            header.replaceChildren(button);
        });
    }

    function stylePriceHeaders() {
        document.querySelectorAll('.subgrid-data th[role="columnheader"][colspan]').forEach(header => {
            const span = header.getAttribute('colspan');
            if (span !== '4' && span !== '5') return;
            header.classList.add(span === '4' ? 'adeo-current-price' : 'adeo-compared-price');
            if (header.querySelector('.adeo-price-label')) return;
            const label = document.createElement('span');
            label.className = 'adeo-price-label';
            label.textContent = span === '4' ? 'Текущий прайс' : 'Прайс сравнения';
            header.prepend(label);
        });
    }

    function formatPriceDifferences() {
        document.querySelectorAll('.subgrid-data td[aria-describedby$="_cp_cost_eval_diff"]').forEach(cell => {
            const raw = cell.textContent.trim();
            if (priceDifferenceValues.get(cell)?.formatted === cell.textContent) return;
            cell.classList.remove('adeo-price-lower', 'adeo-price-higher', 'adeo-price-equal');
            cell.removeAttribute('title');
            const numeric = raw.replace(/\s/g, '').replace(/%$/, '').replace('−', '-').replace(',', '.');
            if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(numeric)) {
                priceDifferenceValues.delete(cell);
                return;
            }
            const value = Number(numeric);
            if (!Number.isFinite(value)) return;
            const amount = Math.abs(value).toLocaleString('ru-RU', { maximumFractionDigits: 20, useGrouping: false });
            const formatted = `${value < 0 ? '−' : value > 0 ? '+' : ''}${amount}%`;
            priceDifferenceValues.set(cell, { raw, formatted });
            cell.classList.add(value < 0 ? 'adeo-price-lower' : value > 0 ? 'adeo-price-higher' : 'adeo-price-equal');
            cell.title = value < 0 ? `Дешевле текущего прайса на ${amount}%` : value > 0 ? `Дороже текущего прайса на ${amount}%` : 'Цена совпадает с текущим прайсом';
            if (cell.textContent !== formatted) cell.textContent = formatted;
        });
    }

    function increaseWorkAreaHeight() {
        const workArea = document.querySelector('div.ui-jqgrid-bdiv');
        if (workArea && workArea.style.height !== '750px') workArea.style.height = '750px';
    }

    function initCompare() {
        observePage(() => {
            addToolbarButtons();
            activateCheckboxWithText('Остаток');
            document.querySelectorAll('select.ui-pg-selbox').forEach(updateDropdownValues);
            addCopyButtons();
            filterSupplierRows();
            syncSupplierScrollHeight();
            addCopyHeaderButtons();
            stylePriceHeaders();
            formatPriceDifferences();
            updateSupplierPresentation();
            increaseWorkAreaHeight();
        });
        // jqGrid меняет состояние раскрытия через классы, без добавления новых строк при повторном открытии.
        document.addEventListener('click', event => {
            if (event.target.closest?.('#supplier_price_unique .ui-sgcollapsed')) {
                setTimeout(updateSupplierPresentation, 0);
            }
        });
    }

    // Календарные дни считаем отдельно от времени: переход часового пояса не меняет срок доставки.
    const SCHEDULE_WEEKDAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
    let scheduleDraftSequence = 0;
    const schedulePad = value => String(value).padStart(2, '0');

    function scheduleDay(value = new Date()) {
        const date = value instanceof Date ? value : new Date(value);
        if (!Number.isFinite(date.getTime())) throw new Error('CRM вернула некорректную дату.');
        return `${date.getFullYear()}-${schedulePad(date.getMonth() + 1)}-${schedulePad(date.getDate())}`;
    }

    function parseScheduleDay(value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error('Укажите дату полностью.');
        const date = new Date(`${value}T12:00:00Z`);
        if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('Некорректная дата.');
        return date;
    }

    function addScheduleDays(value, amount) {
        if (!Number.isInteger(amount)) throw new Error('Срок доставки должен быть целым числом дней.');
        const date = parseScheduleDay(value);
        date.setUTCDate(date.getUTCDate() + amount);
        return date.toISOString().slice(0, 10);
    }

    function scheduleWeekday(value) {
        return (parseScheduleDay(value).getUTCDay() + 6) % 7;
    }

    function nextScheduleWeekday(start, weekday) {
        return addScheduleDays(start, (weekday - scheduleWeekday(start) + 7) % 7);
    }

    function nextScheduleDelivery(day, allowedDays) {
        const allowed = new Set(allowedDays.filter(value => Number.isInteger(value) && value >= 0 && value < 6));
        if (!allowed.size) throw new Error('Выберите хотя бы один день доставки с понедельника по субботу.');
        for (let offset = 0; offset < 7; offset++) {
            const candidate = addScheduleDays(day, offset);
            if (allowed.has(scheduleWeekday(candidate))) return candidate;
        }
        throw new Error('Не удалось подобрать день доставки.');
    }

    function scheduleTime(value) {
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) throw new Error('CRM вернула некорректное время.');
        return `${schedulePad(date.getHours())}:${schedulePad(date.getMinutes())}`;
    }

    function scheduleTimestamp(day, time) {
        parseScheduleDay(day);
        if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time || '')) throw new Error('Укажите время в формате ЧЧ:ММ.');
        const date = new Date(`${day}T${time}:00`);
        if (scheduleDay(date) !== day || scheduleTime(date) !== time) throw new Error('Это местное время недоступно из-за перевода часов.');
        const offset = -date.getTimezoneOffset();
        return `${day}T${time}:00${offset >= 0 ? '+' : '-'}${schedulePad(Math.floor(Math.abs(offset) / 60))}:${schedulePad(Math.abs(offset) % 60)}`;
    }

    function scheduleHourLabel(hour) {
        return `${schedulePad(hour)}:00–${hour === 23 ? '23:59' : `${schedulePad(hour + 1)}:00`}`;
    }

    function scheduleNfile(value) {
        return value === null || value === undefined || value === '' ? '' : String(value);
    }

    function scheduleScopesOverlap(left, right) {
        const a = scheduleNfile(left), b = scheduleNfile(right);
        return a === '' || b === '' || a === b;
    }

    function scheduleReplacesGeneralRule(conflict) {
        return !conflict.group.nfiles.some(value => scheduleNfile(value) === '') &&
            (conflict.weekly.some(series => series.instances.some(event => scheduleNfile(event.nfile) === '')) ||
                conflict.once.some(event => scheduleNfile(event.nfile) === ''));
    }

    function isWeeklySchedule(event) {
        return Boolean(event.weeklyScheduleId) && String(event.weeklyScheduleId) !== '0';
    }

    function scheduleEventToDraft(event, offset = 0) {
        const hasStart = Boolean(event.orderDeliveryIntervalStart);
        const hasEnd = Boolean(event.orderDeliveryIntervalEnd);
        if (hasStart !== hasEnd) throw new Error('В записи CRM неполный интервал доставки. Исправьте её штатной формой.');
        const deliveryTime = hasStart ? scheduleTime(event.orderDeliveryIntervalStart) : '15:00';
        const hour = Number(deliveryTime.slice(0, 2));
        if (hasStart && (deliveryTime !== `${schedulePad(hour)}:00` ||
            scheduleTime(event.orderDeliveryIntervalEnd) !== (hour === 23 ? '23:59' : `${schedulePad(hour + 1)}:00`) ||
            scheduleDay(event.orderDeliveryIntervalStart) !== scheduleDay(event.orderDeliveryIntervalEnd))) {
            throw new Error('В CRM найден нестандартный интервал доставки. Исправьте его штатной формой перед копированием.');
        }
        return {
            uid: String(++scheduleDraftSequence), nfile: event.nfile ?? null,
            sendDate: addScheduleDays(scheduleDay(event.ordersAcceptedAt), offset), sendTime: scheduleTime(event.ordersAcceptedAt),
            haveDelivery: hasStart, deliveryDate: hasStart ? addScheduleDays(scheduleDay(event.orderDeliveryIntervalStart), offset) : '',
            deliveryHour: hour
        };
    }

    function scheduleHasDelivery(draft, deliveryDays) {
        return deliveryDays.length > 0 && draft.haveDelivery;
    }

    function scheduleDraftPayload(draft, supplierId, haveDelivery = draft.haveDelivery) {
        const start = haveDelivery ? `${schedulePad(draft.deliveryHour)}:00` : null;
        const end = haveDelivery ? (draft.deliveryHour === 23 ? '23:59' : `${schedulePad(draft.deliveryHour + 1)}:00`) : null;
        return {
            supplierId, nfile: scheduleNfile(draft.nfile) === '' ? null : draft.nfile, repeatWeekly: true,
            ordersAcceptedAt: scheduleTimestamp(draft.sendDate, draft.sendTime),
            orderDeliveryIntervalStart: start ? scheduleTimestamp(draft.deliveryDate, start) : null,
            orderDeliveryIntervalEnd: end ? scheduleTimestamp(draft.deliveryDate, end) : null
        };
    }

    function validateScheduleDraft(draft, allowedDays, today = scheduleDay()) {
        const errors = [];
        try {
            parseScheduleDay(draft.sendDate);
            if (draft.sendDate <= today) errors.push('Отправку можно назначить только на будущий день.');
            scheduleTimestamp(draft.sendDate, draft.sendTime);
            if (scheduleHasDelivery(draft, allowedDays)) {
                parseScheduleDay(draft.deliveryDate);
                const weekday = scheduleWeekday(draft.deliveryDate);
                if (weekday === 6) errors.push('В воскресенье ваш склад закрыт.');
                else if (!allowedDays.includes(weekday)) errors.push('Поставщик не доставляет в выбранный день недели.');
                if (!Number.isInteger(draft.deliveryHour) || draft.deliveryHour < 0 || draft.deliveryHour > 23) errors.push('Выберите часовой интервал доставки.');
                else {
                    if (weekday === 5 && draft.deliveryHour > 15) errors.push('В субботу выберите интервал не позднее 15:00–16:00.');
                    if (`${draft.deliveryDate}T${schedulePad(draft.deliveryHour)}:00` < `${draft.sendDate}T${draft.sendTime}`) errors.push('Доставка не может начинаться раньше отправки.');
                }
            }
        } catch (error) { errors.push(error.message); }
        return errors;
    }

    function buildScheduleWeek(template, orderDays, deliveryDays, startDate, nfile) {
        parseScheduleDay(startDate);
        if (!orderDays.length) throw new Error('Выберите дни отправки заказов.');
        if (!template.length) throw new Error('Добавьте хотя бы одну отправку в шаблон.');
        for (const row of template) {
            if (scheduleHasDelivery(row, deliveryDays) && (!Number.isInteger(row.leadDays) || row.leadDays < 0)) {
                throw new Error('Срок доставки — целое неотрицательное число дней.');
            }
        }
        return SCHEDULE_WEEKDAYS.map((name, weekday) => {
            const date = nextScheduleWeekday(startDate, weekday);
            const enabled = orderDays.includes(weekday);
            return { date, weekday, enabled, nfiles: [nfile], entries: enabled ? template.map(row => {
                const haveDelivery = scheduleHasDelivery(row, deliveryDays);
                return { uid: String(++scheduleDraftSequence), nfile, sendDate: date, sendTime: row.sendTime,
                    haveDelivery, deliveryDate: haveDelivery ? nextScheduleDelivery(addScheduleDays(date, row.leadDays), deliveryDays) : '',
                    deliveryHour: row.deliveryHour };
            }) : [] };
        });
    }

    function copyScheduleDrafts(entries, sourceDate, targetDate) {
        const offset = (parseScheduleDay(targetDate) - parseScheduleDay(sourceDate)) / 86400000;
        return entries.map(row => ({ ...row, uid: String(++scheduleDraftSequence), sendDate: addScheduleDays(row.sendDate, offset),
            deliveryDate: row.haveDelivery ? addScheduleDays(row.deliveryDate, offset) : '' }));
    }

    // Сравниваем именно поля расписания, чтобы порядок ответа сервера не создавал ложных конфликтов.
    function scheduleFingerprint(events) {
        return JSON.stringify(events.map(event => [String(event.id), String(event.weeklyScheduleId || ''), scheduleNfile(event.nfile),
            event.ordersAcceptedAt, event.orderDeliveryIntervalStart || null, event.orderDeliveryIntervalEnd || null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    }

    function scheduleRecordSignature(event) {
        return JSON.stringify([scheduleNfile(event.nfile), new Date(event.ordersAcceptedAt).getTime(),
            event.orderDeliveryIntervalStart ? new Date(event.orderDeliveryIntervalStart).getTime() : null,
            event.orderDeliveryIntervalEnd ? new Date(event.orderDeliveryIntervalEnd).getTime() : null]);
    }

    function scheduleRepeatSignature(event) {
        const day = scheduleDay(event.ordersAcceptedAt);
        return JSON.stringify([scheduleNfile(event.nfile), scheduleWeekday(day), scheduleTime(event.ordersAcceptedAt),
            event.orderDeliveryIntervalStart ? (parseScheduleDay(scheduleDay(event.orderDeliveryIntervalStart)) - parseScheduleDay(day)) / 86400000 : null,
            event.orderDeliveryIntervalStart ? scheduleTime(event.orderDeliveryIntervalStart) : null,
            event.orderDeliveryIntervalEnd ? (parseScheduleDay(scheduleDay(event.orderDeliveryIntervalEnd)) - parseScheduleDay(day)) / 86400000 : null,
            event.orderDeliveryIntervalEnd ? scheduleTime(event.orderDeliveryIntervalEnd) : null]);
    }

    function findScheduleConflicts(events, groups, today = scheduleDay()) {
        parseScheduleDay(today);
        return groups.filter(group => group.enabled).map(group => {
            const series = new Map();
            const once = [];
            for (const event of events) {
                if (!group.nfiles.some(value => scheduleScopesOverlap(value, event.nfile))) continue;
                const day = scheduleDay(event.ordersAcceptedAt);
                if (group.repeatWeekly === false) {
                    if (day === group.date) once.push(event);
                } else if (isWeeklySchedule(event) && scheduleWeekday(day) === scheduleWeekday(group.date)) {
                    const key = String(event.weeklyScheduleId);
                    if (!series.has(key)) series.set(key, []);
                    series.get(key).push(event);
                } else if (!isWeeklySchedule(event) && day === group.date) once.push(event);
            }
            const weekly = [], historical = [];
            for (const instances of series.values()) {
                // Список CRM содержит и закрытые повторы за прошлые годы. Их история не является конфликтом.
                const future = instances.filter(event => scheduleDay(event.ordersAcceptedAt) > today);
                if (!future.length) { historical.push({ instances }); continue; }
                weekly.push({ instances, first: future.filter(event => scheduleDay(event.ordersAcceptedAt) >= group.date)
                    .sort((a, b) => new Date(a.ordersAcceptedAt) - new Date(b.ordersAcceptedAt))[0] });
            }
            return { group, weekly, historical, once, count: weekly.length + once.length };
        });
    }

    function makeSchedulePlan(events, groups, decisions, supplierId, deliveryDays, today = scheduleDay()) {
        const operations = [];
        let skipped = 0;
        const conflicts = findScheduleConflicts(events, groups, today);
        const removed = new Set();
        for (const conflict of conflicts) {
            const { group, weekly, once, count } = conflict;
            if (group.date <= today) throw new Error('Дата начала уже наступила. Выберите будущую дату.');
            const decision = count ? decisions[group.date] : 'add';
            if (decision === 'skip') continue;
            if (decision !== 'add' && decision !== 'replace') throw new Error('Выберите действие для каждого заполненного дня.');
            if (decision === 'replace' && scheduleReplacesGeneralRule(conflict)) {
                throw new Error(`${group.date}: найдено общее правило для всех складов. Его нельзя удалить при замене только выбранного склада: это изменит расписание остальных. Выберите «Все склады» для общей замены либо измените общее правило штатной формой CRM.`);
            }
            const slots = [];
            for (const row of group.entries) {
                if (row.sendDate !== group.date || !group.nfiles.some(value => scheduleNfile(value) === scheduleNfile(row.nfile))) throw new Error('Запись оказалась вне выбранного дня или склада.');
                const errors = validateScheduleDraft(row, deliveryDays, today);
                if (errors.length) throw new Error(`${group.date}: ${errors.join(' ')}`);
                if (slots.some(slot => slot.sendTime === row.sendTime && scheduleScopesOverlap(slot.nfile, row.nfile))) {
                    throw new Error(`${group.date}: две отправки для пересекающихся складов назначены на ${row.sendTime}.`);
                }
                slots.push(row);
            }
            if (decision === 'replace') {
                for (const series of weekly) {
                    if (!series.first) throw new Error(`${group.date}: CRM пока не загрузила будущий экземпляр повтора. Замену выполнить нельзя; выберите более близкую дату или добавление.`);
                    const key = `weekly:${series.first.weeklyScheduleId}`;
                    if (!removed.has(key)) {
                        removed.add(key);
                        operations.push({ type: 'remove', event: series.first, future: true, boundary: group.date });
                    }
                }
                for (const event of once) {
                    const key = `once:${event.id}`;
                    if (!removed.has(key)) { removed.add(key); operations.push({ type: 'remove', event, future: false, boundary: group.date }); }
                }
            }
            for (const draft of group.entries) {
                const payload = { ...scheduleDraftPayload(draft, supplierId, scheduleHasDelivery(draft, deliveryDays)), repeatWeekly: group.repeatWeekly !== false };
                if (decision === 'add') {
                    const sameWeeklySlot = weekly.filter(series => series.instances.some(event =>
                        scheduleScopesOverlap(event.nfile, draft.nfile) && scheduleTime(event.ordersAcceptedAt) === draft.sendTime));
                    const identical = payload.repeatWeekly ? sameWeeklySlot.some(series => series.first && series.instances.some(event =>
                        scheduleDay(event.ordersAcceptedAt) <= group.date && scheduleRepeatSignature(event) === scheduleRepeatSignature(payload)))
                        : once.some(event => scheduleRecordSignature(event) === scheduleRecordSignature(payload));
                    if (identical) { skipped++; continue; }
                    if (sameWeeklySlot.length || once.some(event => scheduleScopesOverlap(event.nfile, draft.nfile) && scheduleTime(event.ordersAcceptedAt) === draft.sendTime)) {
                        throw new Error(`${group.date}, ${draft.sendTime}: в пересекающемся расписании уже существует отправка для этих складов. Выберите «Заменить», если замена доступна, или другое время.`);
                    }
                }
                operations.push({ type: 'create', payload });
            }
        }
        return { operations, skipped, index: 0, created: 0, deleted: 0, uncertain: false, error: '' };
    }

    function makeScheduleClearPlan(events, supplierId, today = scheduleDay()) {
        parseScheduleDay(today);
        const weekly = new Map(), once = new Map();
        let futureCount = 0;
        for (const event of events) {
            if (event.supplierId != null && String(event.supplierId) !== String(supplierId)) throw new Error('В расписании найдены записи другого поставщика. Очистка отменена.');
            if (event.id === null || event.id === undefined) throw new Error('В записи отсутствует номер. Очистка отменена.');
            if (scheduleDay(event.ordersAcceptedAt) <= today) continue;
            futureCount++;
            if (isWeeklySchedule(event)) {
                const key = String(event.weeklyScheduleId);
                const previous = weekly.get(key);
                if (!previous || new Date(event.ordersAcceptedAt) < new Date(previous.ordersAcceptedAt)) weekly.set(key, event);
            } else once.set(String(event.id), event);
        }
        const boundary = addScheduleDays(today, 1);
        const operations = [
            ...[...weekly.values()].map(event => ({ type: 'remove', event, future: true, boundary })),
            ...[...once.values()].map(event => ({ type: 'remove', event, future: false, boundary }))
        ].sort((a, b) => new Date(a.event.ordersAcceptedAt) - new Date(b.event.ordersAcceptedAt));
        return { operations, skipped: 0, index: 0, created: 0, deleted: 0, uncertain: false, error: '',
            clearing: true, supplierId, ruleCount: weekly.size, onceCount: once.size, futureCount };
    }

    // Проверяем конкретную дату: наличие еженедельного правила не гарантирует отправку в праздник.
    function missingScheduleCopies(events, drafts, supplierId) {
        const existing = new Set(events.map(scheduleRecordSignature));
        return drafts.filter(draft => !existing.has(scheduleRecordSignature(scheduleDraftPayload(draft, supplierId))));
    }

    // Используем тот же объект $API, что и штатный CalendarEventEditor; адреса и авторизацию не дублируем.
    function createScheduleAdapter(proxy) {
        const native = proxy?.$API?.supplier?.schedule;
        if (!native || !['list', 'create', 'remove'].every(name => typeof native[name] === 'function')) throw new Error('Не удалось подключиться к штатным функциям календаря CRM. Обновите страницу.');
        return {
            async list(supplierId) {
                const response = await native.list(supplierId);
                if (!Array.isArray(response?.data)) throw new Error('CRM вернула неизвестный формат расписания. Изменения не отправлены.');
                for (const event of response.data) {
                    if (event.id === undefined || event.id === null) throw new Error('В ответе CRM отсутствует номер записи.');
                    scheduleDay(event.ordersAcceptedAt);
                    if (event.supplierId != null && String(event.supplierId) !== String(supplierId)) throw new Error('CRM вернула расписание другого поставщика.');
                }
                return response.data;
            },
            async create(payload) { return await native.create(payload); },
            async remove(event, future) { return await native.remove(event.id, future); }
        };
    }

    // Показываем тело ответа сервера, не копируя заголовки авторизации и служебные настройки запроса.
    function describeScheduleRequestError(error, operation) {
        const status = Number(error?.response?.status || error?.status) || null;
        const data = error?.response?.data;
        let responseText = '';
        const seen = new Set();
        function messages(value) {
            if (value === null || value === undefined) return [];
            if (typeof value === 'string') {
                const text = value.trim();
                if (!text) return [];
                try { return messages(JSON.parse(text)); } catch { return [text]; }
            }
            if (typeof value !== 'object') return [String(value)];
            if (seen.has(value)) return [];
            seen.add(value);
            if (Array.isArray(value)) return value.slice(0, 20).flatMap(messages);
            const parts = ['message', 'error', 'errors', 'detail', 'details', 'reason', 'description', 'violations', 'fieldErrors', 'defaultMessage']
                .filter(key => value[key] !== undefined).flatMap(key => messages(value[key]));
            if (parts.length) return parts;
            try { return [JSON.stringify(value)]; } catch { return []; }
        }
        try { responseText = [...new Set(messages(data))].join('\n').slice(0, 3000); } catch { /* Сохраняем основное сообщение, даже если формат ответа неизвестен. */ }
        const subject = operation?.type === 'remove' ? 'удалении записи расписания'
            : operation?.payload?.repeatWeekly === false ? 'создании одноразовой записи' : 'создании еженедельной записи';
        const lines = [status ? `CRM вернула HTTP ${status} при ${subject}.` : `Ошибка при ${subject}.`];
        const entry = operation?.payload || operation?.event;
        if (entry) {
            try {
                lines.push(`Отправка: ${scheduleDay(entry.ordersAcceptedAt)} ${scheduleTime(entry.ordersAcceptedAt)}. Склад: ${scheduleNfile(entry.nfile) || 'все (общая запись)'}.`);
                if (entry.orderDeliveryIntervalStart && entry.orderDeliveryIntervalEnd) lines.push(`Доставка: ${scheduleDay(entry.orderDeliveryIntervalStart)} ${scheduleTime(entry.orderDeliveryIntervalStart)}–${scheduleTime(entry.orderDeliveryIntervalEnd)}.`);
            } catch { /* Ошибка формата записи не должна скрывать исходный ответ CRM. */ }
        }
        lines.push(responseText ? `Ответ CRM: ${responseText}` : `Причина: ${error?.message || 'Сервер не сообщил подробности.'}`);
        return lines.join('\n');
    }

    async function runSchedulePlan(job, adapter, checkContext, onProgress = () => {}) {
        if (job.uncertain) throw new Error('Сначала проверьте результат прерванной операции.');
        while (job.index < job.operations.length) {
            checkContext();
            const operation = job.operations[job.index];
            const date = operation.type === 'create' ? scheduleDay(operation.payload.ordersAcceptedAt) : scheduleDay(operation.event.ordersAcceptedAt);
            if (date <= scheduleDay()) throw new Error('Наступил день одной из отправок. Обновите даты перед продолжением.');
            try {
                if (operation.type === 'create') { await adapter.create(operation.payload); job.created++; }
                else { await adapter.remove(operation.event, operation.future); job.deleted++; }
                job.index++;
                onProgress(job);
            } catch (error) {
                job.uncertain = true;
                job.error = describeScheduleRequestError(error, operation);
                onProgress(job);
                throw new Error(job.error, { cause: error });
            }
        }
        return job;
    }

    async function reconcileSchedulePlan(job, adapter, supplierId) {
        if (!job.uncertain) return true;
        const events = await adapter.list(supplierId);
        const operation = job.operations[job.index];
        const complete = operation.type === 'create'
            ? events.some(event => isWeeklySchedule(event) === (operation.payload.repeatWeekly !== false) && scheduleRecordSignature(event) === scheduleRecordSignature(operation.payload))
            : !events.some(event => operation.future
                ? String(event.weeklyScheduleId) === String(operation.event.weeklyScheduleId) && scheduleDay(event.ordersAcceptedAt) >= operation.boundary
                : String(event.id) === String(operation.event.id));
        if (!complete) return false;
        if (operation.type === 'create') job.created++;
        else job.deleted++;
        job.index++;
        job.uncertain = false;
        job.error = '';
        return true;
    }

    function findScheduleProxy(element) {
        const isCalendar = instance => {
            const proxy = instance?.proxy;
            return proxy && (instance.type?.name === 'WorkCalendarQuasar' || proxy.$options?.name === 'WorkCalendarQuasar') &&
                (proxy.$el === element || proxy.$el?.contains?.(element)) ? proxy : null;
        };
        for (let node = element; node; node = node.parentElement) {
            for (let instance = node.__vueParentComponent; instance; instance = instance.parent) {
                const proxy = isCalendar(instance);
                if (proxy) return proxy;
            }
        }
        const app = document.querySelector('#q-app')?.__vue_app__;
        const queue = [app?._container?._vnode, app?._instance?.vnode];
        const visited = new Set();
        // Обход дерева VNode работает и в сборке Vue без средств разработчика.
        while (queue.length) {
            const vnode = queue.pop();
            if (!vnode || typeof vnode !== 'object' || visited.has(vnode)) continue;
            visited.add(vnode);
            if (Array.isArray(vnode)) { queue.push(...vnode); continue; }
            const proxy = isCalendar(vnode.component);
            if (proxy) return proxy;
            queue.push(vnode.component?.subTree, vnode.children, vnode.suspense?.activeBranch);
        }
        return null;
    }

    function installScheduleStyles() {
        if (document.getElementById('adeo-schedule-styles')) return;
        const style = document.createElement('style');
        style.id = 'adeo-schedule-styles';
        style.textContent = `
            .adeo-schedule-launch,.adeo-schedule-clear{border:1px solid #1976d2;border-radius:7px;background:#1976d2;color:#fff;padding:9px 14px;cursor:pointer;margin:4px 6px;font:inherit}.adeo-schedule-clear{border-color:#d3b6b5;background:white;color:#b3261e}
            .adeo-schedule-overlay{position:fixed;inset:0;background:#14243f99;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:20px;color:#24344a;font:14px/1.45 Arial,sans-serif;text-align:left;letter-spacing:normal}
            .adeo-schedule-overlay,.adeo-schedule-overlay *{box-sizing:border-box}.adeo-schedule-overlay [hidden]{display:none!important}
            .adeo-schedule-modal{--adeo-dialog-width:940px;background:#f6f8fc;width:var(--adeo-dialog-width);max-width:calc(100vw - 40px);max-height:calc(100dvh - 40px);min-height:0;display:flex;flex-direction:column;border-radius:14px;box-shadow:0 20px 80px #09182d4d;overflow:hidden;margin:0}
            .adeo-schedule-modal[data-phase="template"]{--adeo-dialog-width:1260px}.adeo-schedule-modal[data-phase="review"][data-mode="new"]{--adeo-dialog-width:1680px}.adeo-schedule-modal[data-phase="confirm"],.adeo-schedule-modal[data-phase="clear-confirm"]{--adeo-dialog-width:1100px}.adeo-schedule-modal[data-view="copy-choice"]{width:640px}
            .adeo-schedule-modal h2,.adeo-schedule-modal h3{letter-spacing:normal;text-transform:none;text-align:left;color:#24344a}.adeo-schedule-modal h3{font:600 18px/1.4 Arial,sans-serif;margin:0 0 12px}.adeo-schedule-modal p{font:inherit;letter-spacing:normal}
            .adeo-schedule-header{background:#1976d2;color:white;padding:17px 24px;display:flex;align-items:center;gap:16px;flex-shrink:0}.adeo-schedule-header h2{font:600 20px/1.3 Arial,sans-serif;margin:0;flex:1;color:white}
            .adeo-schedule-modal .adeo-schedule-close{background:#ffffff14;color:white;border:0;border-radius:7px;width:34px;height:34px;min-height:34px;font:25px/1 Arial,sans-serif;cursor:pointer;padding:0}.adeo-schedule-close:hover{background:#ffffff2b}
            .adeo-schedule-steps{display:flex;align-items:center;gap:10px;padding:13px 24px;background:white;border-bottom:1px solid #e1e7f0;flex-shrink:0;overflow-x:auto}.adeo-schedule-step{display:flex;align-items:center;gap:7px;font:13px/1.3 Arial,sans-serif;color:#78869b;white-space:nowrap}.adeo-schedule-step b{display:grid;place-items:center;border:1px solid #d7dfeb;border-radius:50%;width:23px;height:23px;font:600 12px Arial}.adeo-schedule-step.current{color:#1565b7;font-weight:600}.adeo-schedule-step.current b{background:#1976d2;border-color:#1976d2;color:white}.adeo-schedule-step.done{color:#325e89}.adeo-schedule-step+.adeo-schedule-step:before{content:'›';color:#b4bfce;margin-right:3px}
            .adeo-schedule-content{padding:22px 24px;overflow:auto;min-height:0;overscroll-behavior:contain;scrollbar-gutter:stable}.adeo-schedule-footer{padding:14px 24px;display:flex;gap:10px;justify-content:flex-end;align-items:center;border-top:1px solid #dce3ee;background:white;flex-shrink:0;flex-wrap:wrap}.adeo-schedule-footer:empty{display:none}.adeo-schedule-footer>:first-child:not(:only-child){margin-right:auto}
            .adeo-schedule-overlay button,.adeo-schedule-overlay input,.adeo-schedule-overlay select{font:14px/1.3 Arial,sans-serif;letter-spacing:normal;text-transform:none;margin:0;box-shadow:none}.adeo-schedule-overlay button{width:auto;min-width:0}.adeo-schedule-button{background:white;border:1px solid #cbd5e3;border-radius:7px;color:#30445f;padding:9px 12px;min-height:38px;cursor:pointer;transition:background .12s,border-color .12s}.adeo-schedule-button:hover{background:#f1f6fd;border-color:#91afcf}.adeo-schedule-button.primary{background:#1976d2;color:white;border-color:#1976d2}.adeo-schedule-button.primary:hover{background:#1267bd}.adeo-schedule-button.danger{color:#b3261e;border-color:#e1c2c0}.adeo-schedule-button.danger:hover{background:#fff1f0;border-color:#ce9c98}
            .adeo-schedule-overlay button:disabled{opacity:.45;cursor:default}.adeo-schedule-overlay :focus-visible{outline:3px solid #efb73d;outline-offset:2px}
            .adeo-schedule-field{display:flex;flex-direction:column;gap:6px;margin:8px 0;min-width:0;font:13px/1.3 Arial,sans-serif;color:#50627b}.adeo-schedule-field input,.adeo-schedule-field select{background:white;border:1px solid #c9d4e3;border-radius:6px;padding:8px 9px;min-height:38px;min-width:0;width:100%;color:#24344a}.adeo-schedule-field select:disabled,.adeo-schedule-field input:disabled{background:#f1f3f7;color:#78869b}
            .adeo-schedule-check{display:inline-flex;align-items:center;gap:7px;margin:6px 14px 6px 0;font:13px/1.4 Arial,sans-serif;cursor:pointer}.adeo-schedule-check input{width:16px;height:16px;min-height:0;flex-shrink:0;margin:0;accent-color:#1976d2}.adeo-schedule-check:has(input:disabled){color:#98a2b2;cursor:default}
            .adeo-schedule-box{padding:17px 18px;background:white;border:1px solid #dfe6f0;border-radius:9px;margin:0 0 16px}.adeo-schedule-box h3{font:600 15px/1.4 Arial,sans-serif;margin:0 0 13px}.adeo-schedule-form-pair{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:20px}.adeo-schedule-setup-days{display:grid;grid-template-columns:1fr 1fr;gap:16px}.adeo-schedule-setup-days>.adeo-schedule-box{margin:0}
            .adeo-schedule-weekdays{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}.adeo-schedule-weekdays .adeo-schedule-check{flex-direction:column;justify-content:center;gap:7px;padding:10px 3px;margin:0;border:1px solid #dee5ee;background:#fafbfd;border-radius:7px;min-height:65px;color:#52637a}.adeo-schedule-weekdays .adeo-schedule-check:has(input:checked){background:#eaf3ff;border-color:#8fb8e4;color:#145fa9;font-weight:600}.adeo-schedule-weekdays .adeo-schedule-check:has(input:disabled){background:#f6f7f9;border-style:dashed;color:#a1aaba}.adeo-schedule-day-presets{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}.adeo-schedule-day-presets .adeo-schedule-button{min-height:28px;padding:4px 8px;font-size:12px}
            .adeo-schedule-note{color:#65758d;margin:8px 0;font:13px/1.5 Arial,sans-serif}.adeo-schedule-error{color:#a92323;white-space:pre-line;margin:8px 0;font:13px/1.45 Arial,sans-serif}.adeo-schedule-error:empty{display:none}.adeo-schedule-content>[role="alert"]:not(:empty){padding:12px 15px;background:#fff1f0;border:1px solid #efc4c0;border-radius:8px;margin:0 0 16px;max-height:140px;overflow:auto}.adeo-schedule-success{color:#176238}
            .adeo-schedule-grid{display:grid;grid-template-columns:repeat(7,minmax(168px,1fr));gap:9px;align-items:start;overflow-x:auto;padding-bottom:12px}.adeo-schedule-grid.copy{grid-template-columns:minmax(0,1fr)}.adeo-schedule-day{background:white;border:1px solid #dce3ee;border-radius:9px;overflow:hidden;min-width:0}.adeo-schedule-day header{background:#edf2fa;padding:12px;font:600 14px/1.4 Arial,sans-serif}.adeo-schedule-day header small{display:block;font:12px/1.5 Arial,sans-serif;color:#63758e;margin-top:3px}.adeo-schedule-day[data-enabled="false"]{background:#f8fafc}.adeo-schedule-day[data-enabled="false"] header{background:#f0f2f6;color:#8592a6}.adeo-schedule-day-body{padding:10px}.adeo-schedule-day-body>.adeo-schedule-check{margin:0 0 10px;font-size:12px}
            .adeo-schedule-day-actions{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}.adeo-schedule-day-actions .adeo-schedule-button{flex:1;padding:6px 7px;min-height:32px;font-size:12px}.adeo-schedule-copy-tools{margin:0 0 10px;border-bottom:1px solid #e6ebf2;padding-bottom:8px}.adeo-schedule-copy-tools>summary{cursor:pointer;font:12px/1.4 Arial,sans-serif;color:#4b6d95;padding:5px 0}.adeo-schedule-copy-tools .adeo-schedule-field{font-size:12px}.adeo-schedule-copy-tools .adeo-schedule-button{font-size:12px;padding:6px 9px;min-height:32px}
            .adeo-schedule-row{border:1px solid #dce3ee;border-radius:7px;padding:10px;margin:8px 0;background:white;min-width:0}.adeo-schedule-row-tools{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}.adeo-schedule-row-tools button{padding:5px 8px;min-height:30px;font-size:12px}.adeo-schedule-row-number{font:600 12px Arial,sans-serif;color:#8c9ab0;align-self:center}
            details.adeo-schedule-row>summary{cursor:pointer;list-style:none;font:13px/1.4 Arial,sans-serif;position:relative;padding-right:16px}.adeo-schedule-modal summary::-webkit-details-marker{display:none}details.adeo-schedule-row>summary:after{content:'⌄';position:absolute;right:0;top:0;color:#7c8da6}details.adeo-schedule-row[open]>summary:after{content:'⌃'}details.adeo-schedule-row[open]>summary{padding-bottom:10px;border-bottom:1px solid #e2e8f1;margin-bottom:8px}.adeo-schedule-row-time{display:block;font:600 15px/1.4 Arial,sans-serif;color:#263f5b}.adeo-schedule-row-delivery-text{display:block;font:12px/1.5 Arial,sans-serif;color:#6a7a91;margin-top:3px}.adeo-schedule-row-issue{display:block;font:12px/1.4 Arial,sans-serif;color:#b3261e;margin-top:5px}.adeo-schedule-row-invalid{border-color:#e0a6a1;background:#fff8f7}.adeo-schedule-row-invalid .adeo-schedule-row-time{color:#a92323}
            .adeo-schedule-grid.copy .adeo-schedule-row>summary{display:grid;grid-template-columns:minmax(160px,.8fr) minmax(200px,1.5fr);align-items:center;gap:8px}.adeo-schedule-grid.copy .adeo-schedule-row-delivery-text{margin:0;font-size:13px}.adeo-schedule-grid.copy .adeo-schedule-row-issue{grid-column:1/-1}.adeo-schedule-grid.copy details[open]>.adeo-schedule-field{max-width:300px}.adeo-schedule-grid.copy .adeo-schedule-row-delivery{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:end}.adeo-schedule-grid.copy .adeo-schedule-row-delivery>.adeo-schedule-button{grid-column:1/-1;justify-self:start}
            .adeo-schedule-template{display:flex;flex-direction:column;gap:8px;max-width:none;width:100%}.adeo-schedule-template .adeo-schedule-row{display:grid;grid-template-columns:25px minmax(110px,1fr) 145px minmax(270px,2.2fr) auto;align-items:center;gap:14px;margin:0;padding:12px 14px}.adeo-schedule-template .adeo-schedule-field{margin:0}.adeo-schedule-template .adeo-schedule-check{margin:0}.adeo-schedule-template .adeo-schedule-row-delivery{display:grid;grid-template-columns:minmax(100px,1fr) minmax(150px,1.3fr);gap:14px}
            .adeo-schedule-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;background:#f6f8fc;position:sticky;top:-22px;z-index:2;margin-bottom:6px}.adeo-schedule-toolbar strong{font-size:14px}.adeo-schedule-mode{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:14px}.adeo-schedule-mode .adeo-schedule-button{display:flex;flex-direction:column;align-items:start;text-align:left;padding:22px;min-height:150px;background:white;border:1px solid #d4e1f0;box-shadow:0 2px 6px #233d5f06;color:#243b58}.adeo-schedule-mode .adeo-schedule-button:hover{border-color:#74a6dc;background:#f5f9ff}.adeo-schedule-mode strong{font:600 17px/1.4 Arial,sans-serif}.adeo-schedule-mode small{display:block;font:13px/1.6 Arial,sans-serif;color:#6b7e96;margin-top:10px}.adeo-schedule-mode-icon{display:grid;place-items:center;width:32px;height:32px;border-radius:8px;background:#eaf3ff;color:#1976d2;font-size:20px;margin-bottom:12px}
            .adeo-schedule-danger-zone{display:flex;gap:16px;align-items:center;justify-content:space-between;margin-top:20px;padding-top:16px;border-top:1px solid #e0e6ee}.adeo-schedule-danger-zone .adeo-schedule-note{margin:0;max-width:450px}
            .adeo-schedule-flex{display:flex;align-items:end;gap:12px;flex-wrap:wrap}.adeo-schedule-flex>.adeo-schedule-field{min-width:180px}.adeo-schedule-summary{font:600 13px/1.5 Arial,sans-serif;margin:12px 0 16px;padding:12px 14px;border:1px solid #dce6f3;border-radius:8px;background:#edf4fe;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.adeo-schedule-summary.has-issues{background:#fff4ed;border-color:#f0d0b9;color:#945227}.adeo-schedule-summary .adeo-schedule-button{padding:5px 10px;min-height:30px;font-size:12px}
            .adeo-schedule-settings{padding:12px 16px;background:white;border:1px solid #e0e7f1;border-radius:8px;margin:12px 0}.adeo-schedule-settings>summary{cursor:pointer;font:13px/1.5 Arial,sans-serif;color:#536e91}.adeo-schedule-settings>.adeo-schedule-box{border:0;padding:16px 0 0;margin:0}.adeo-schedule-settings[open]>summary{margin-bottom:4px}.adeo-schedule-bulkbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px 0 16px}.adeo-schedule-bulkbar .adeo-schedule-button{min-height:32px;padding:6px 10px;font-size:12px}
            .adeo-schedule-conflict{background:white;border:1px solid #dce4ee;border-radius:9px;padding:16px 18px;margin:12px 0}.adeo-schedule-conflict-head{display:grid;grid-template-columns:minmax(145px,1fr) minmax(180px,1.2fr) minmax(180px,1fr);align-items:center;gap:18px}.adeo-schedule-conflict-head strong{font-size:14px}.adeo-schedule-conflict-head .adeo-schedule-field{margin:0}.adeo-schedule-conflict-details{margin-top:12px}.adeo-schedule-conflict-details>summary{cursor:pointer;color:#536e91;font:13px/1.5 Arial,sans-serif;padding:5px 0}.adeo-schedule-history{border-top:1px dashed #dfe5ed;padding-top:8px}.adeo-schedule-warning{color:#8a5c21;background:#fff8e9;border:1px solid #efdfb9;border-radius:6px;padding:9px 12px;margin:10px 0;font:13px/1.5 Arial,sans-serif}
            .adeo-schedule-table-wrap{overflow:auto;margin-top:8px;max-height:340px}.adeo-schedule-table{border-collapse:collapse;width:100%;font:13px/1.5 Arial,sans-serif;white-space:nowrap}.adeo-schedule-table th,.adeo-schedule-table td{text-align:left;padding:8px 12px;border:0;border-bottom:1px solid #e8edf4;background:white;color:#50627b;font:13px/1.5 Arial,sans-serif}.adeo-schedule-table th{font-weight:600;background:#f3f6fa;color:#516781;position:sticky;top:0}.adeo-schedule-table td:first-child{font-weight:600;color:#294360}
            .adeo-schedule-progress{width:100%;height:14px;accent-color:#1976d2;margin:10px 0}.adeo-schedule-progress-panel{padding:20px;border:1px solid #dce5ef;background:white;border-radius:9px}
            @media(max-width:1100px){.adeo-schedule-grid{grid-template-columns:repeat(7,minmax(180px,1fr))}.adeo-schedule-grid.copy{grid-template-columns:1fr}.adeo-schedule-template .adeo-schedule-row{gap:10px;grid-template-columns:22px minmax(100px,1fr) 130px minmax(250px,2fr) auto}.adeo-schedule-row-tools{gap:4px}}
            @media(max-width:820px){.adeo-schedule-overlay{padding:8px}.adeo-schedule-modal{max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px)}.adeo-schedule-content{padding:16px}.adeo-schedule-header{padding:14px 16px}.adeo-schedule-steps{padding:11px 16px;gap:6px}.adeo-schedule-step{font-size:12px}.adeo-schedule-setup-days{grid-template-columns:1fr}.adeo-schedule-conflict-head{grid-template-columns:1fr 1fr}.adeo-schedule-conflict-head>.adeo-schedule-field{grid-column:1/-1}.adeo-schedule-footer{padding:12px 16px}.adeo-schedule-template .adeo-schedule-row{grid-template-columns:25px 1fr 1fr}.adeo-schedule-template .adeo-schedule-row-delivery{grid-column:2/-1}.adeo-schedule-template .adeo-schedule-row-tools{grid-column:2/-1}.adeo-schedule-toolbar{top:-16px}.adeo-schedule-mode .adeo-schedule-button{padding:16px}.adeo-schedule-danger-zone{align-items:start}.adeo-schedule-grid.copy .adeo-schedule-row>summary{grid-template-columns:1fr}}
            @media(max-width:520px){.adeo-schedule-form-pair,.adeo-schedule-mode{grid-template-columns:1fr;gap:12px}.adeo-schedule-header h2{font-size:17px}.adeo-schedule-modal h3{font-size:17px}.adeo-schedule-box{padding:14px}.adeo-schedule-danger-zone{flex-direction:column}.adeo-schedule-footer .adeo-schedule-button{max-width:100%}.adeo-schedule-check{font-size:12px}.adeo-schedule-template .adeo-schedule-row{padding:10px;gap:8px}.adeo-schedule-template .adeo-schedule-row-delivery{grid-template-columns:1fr}.adeo-schedule-weekdays{gap:4px}.adeo-schedule-step b{display:none}.adeo-schedule-day-presets{gap:4px}.adeo-schedule-weekdays .adeo-schedule-check{padding:8px 2px}.adeo-schedule-grid.copy .adeo-schedule-row-delivery{grid-template-columns:1fr}}
        `;
        document.head.append(style);
    }

    function scheduleElement(tag, text, className) {
        const element = document.createElement(tag);
        if (text !== undefined && text !== null) element.textContent = text;
        if (className) element.className = className;
        return element;
    }

    function displayScheduleDay(value, withYear = true) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return value || 'Укажите дату';
        return `${value.slice(8, 10)}.${value.slice(5, 7)}${withYear ? `.${value.slice(0, 4)}` : ''}`;
    }

    function scheduleEntryCount(count) {
        const ending = count % 100 >= 11 && count % 100 <= 14 ? 'записей'
            : count % 10 === 1 ? 'запись' : count % 10 >= 2 && count % 10 <= 4 ? 'записи' : 'записей';
        return `${count} ${ending}`;
    }

    async function openScheduleWizard(calendar, launcher, initialMode = '') {
        if (document.querySelector('.adeo-schedule-overlay')) return;
        const proxy = findScheduleProxy(calendar);
        if (!proxy?.supplier?.id) { alert('Не удалось определить выбранного поставщика. Обновите CRM и снова откройте календарь.'); return; }
        let adapter;
        try { adapter = createScheduleAdapter(proxy); } catch (error) { alert(error.message); return; }
        installScheduleStyles();
        const supplierId = proxy.supplier.id;
        const state = {
            phase: 'loading', mode: initialMode === 'clear' ? 'clear' : '', startDate: addScheduleDays(scheduleDay(), 1), sourceDate: addScheduleDays(scheduleDay(), 1),
            targetDate: addScheduleDays(scheduleDay(), 2), repeatWeekly: true, nfile: null, storages: [], orderDays: [0, 1, 2, 3, 4], deliveryDays: [0, 1, 2, 3, 4],
            template: [{ uid: String(++scheduleDraftSequence), sendTime: '09:00', leadDays: 1, deliveryHour: 15, haveDelivery: true }],
            groups: [], events: [], decisions: {}, snapshot: '', dirty: false, busy: false, error: '', job: null
        };
        const overlay = scheduleElement('div', null, 'adeo-schedule-overlay');
        const modal = scheduleElement('section', null, 'adeo-schedule-modal');
        modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'adeo-schedule-title');
        modal.tabIndex = -1;
        const header = scheduleElement('div', null, 'adeo-schedule-header');
        const heading = scheduleElement('h2', `Расписание — ${proxy.supplier.cella || supplierId}`); heading.id = 'adeo-schedule-title';
        const closeButton = scheduleElement('button', '×', 'adeo-schedule-close'); closeButton.type = 'button'; closeButton.setAttribute('aria-label', 'Закрыть мастер');
        header.append(heading, closeButton);
        const content = scheduleElement('div', null, 'adeo-schedule-content');
        const footer = scheduleElement('div', null, 'adeo-schedule-footer');
        const steps = scheduleElement('nav', null, 'adeo-schedule-steps'); steps.setAttribute('aria-label', 'Шаги работы с расписанием');
        const errorBox = scheduleElement('div', '', 'adeo-schedule-error'); errorBox.setAttribute('role', 'alert');
        modal.append(header, steps, content, footer); overlay.append(modal);
        const host = calendar.closest('.q-dialog__inner') || document.body;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden'; host.append(overlay); modal.focus();

        const assertContext = () => {
            if (!calendar.isConnected || String(proxy.supplier?.id) !== String(supplierId) || !/^\/supplier\/supplier-list\/?$/.test(window.location.pathname)) {
                throw new Error('Выбранный поставщик или страница изменились. Закройте мастер и откройте его заново.');
            }
        };
        function close() {
            if (state.busy) return;
            if (state.phase !== 'done' && state.dirty && !window.confirm('Закрыть мастер? Несохранённый черновик будет потерян. Уже выполненные операции в CRM сохранятся.')) return;
            overlay.remove(); document.body.style.overflow = previousOverflow;
            document.removeEventListener('keydown', onKey, true);
            if (launcher.isConnected) launcher.focus();
        }
        function onKey(event) {
            if (!overlay.isConnected) return;
            if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
            if (event.key === 'Tab') {
                const focusable = [...modal.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')].filter(node => node.getClientRects().length);
                if (!focusable.length) { event.preventDefault(); modal.focus(); return; }
                const first = focusable[0], last = focusable[focusable.length - 1];
                if (event.shiftKey && (document.activeElement === first || document.activeElement === modal)) { event.preventDefault(); last.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
            }
        }
        closeButton.addEventListener('click', close); document.addEventListener('keydown', onKey, true);

        function showError(error) { state.error = error?.message || String(error); errorBox.textContent = state.error; errorBox.scrollIntoView({ block: 'nearest' }); }
        function clearError() { state.error = ''; errorBox.textContent = ''; }
        function setBusy(value) {
            state.busy = value; closeButton.disabled = value;
            modal.setAttribute('aria-busy', String(value));
            for (const input of [...content.querySelectorAll('button,input,select'), ...footer.querySelectorAll('button')]) {
                if (value) { input.dataset.schedulePreviousDisabled = String(input.disabled); input.disabled = true; }
                else if ('schedulePreviousDisabled' in input.dataset) {
                    input.disabled = input.dataset.schedulePreviousDisabled === 'true'; delete input.dataset.schedulePreviousDisabled;
                }
            }
        }
        function button(parent, label, action, kind = '') {
            const node = scheduleElement('button', label, `adeo-schedule-button ${kind}`); node.type = 'button';
            node.addEventListener('click', async () => {
                if (state.busy) return;
                clearError();
                try { await action(); } catch (error) { showError(error); }
            });
            parent.append(node); return node;
        }
        function note(parent, text) { parent.append(scheduleElement('p', text, 'adeo-schedule-note')); }
        function field(parent, label, type, value, change, options = {}) {
            const wrapper = scheduleElement('label', null, 'adeo-schedule-field'); wrapper.append(scheduleElement('span', label));
            const input = scheduleElement('input'); input.type = type; input.value = value ?? '';
            input.setAttribute('aria-label', label);
            for (const [key, item] of Object.entries(options)) input.setAttribute(key, item);
            input.addEventListener('change', () => {
                if (state.busy) return;
                state.dirty = true;
                try { change(input.value); } catch (error) { showError(error); }
            });
            wrapper.append(input); parent.append(wrapper); return input;
        }
        function select(parent, label, value, choices, change) {
            const wrapper = scheduleElement('label', null, 'adeo-schedule-field'); wrapper.append(scheduleElement('span', label));
            const input = scheduleElement('select');
            input.setAttribute('aria-label', label);
            for (const choice of choices) { const option = scheduleElement('option', choice.label); option.value = choice.value; option.disabled = Boolean(choice.disabled); input.append(option); }
            input.value = value ?? '';
            input.addEventListener('change', () => {
                if (state.busy) return;
                state.dirty = true;
                try { change(input.value); } catch (error) { showError(error); }
            });
            wrapper.append(input); parent.append(wrapper); return input;
        }
        function check(parent, label, checked, change, disabled = false) {
            const wrapper = scheduleElement('label', null, 'adeo-schedule-check'); const input = scheduleElement('input'); input.type = 'checkbox'; input.checked = checked; input.disabled = disabled;
            input.setAttribute('aria-label', label);
            input.addEventListener('change', () => {
                if (state.busy) return;
                state.dirty = true;
                try { change(input.checked); } catch (error) { showError(error); }
            }); wrapper.append(input, scheduleElement('span', label)); parent.append(wrapper); return input;
        }
        function weekdays(parent, label, property, delivery = false) {
            const box = scheduleElement('div', null, 'adeo-schedule-box'); box.append(scheduleElement('h3', label));
            const choices = scheduleElement('div', null, 'adeo-schedule-weekdays');
            SCHEDULE_WEEKDAYS.forEach((name, day) => {
                const input = check(choices, name, state[property].includes(day), checked => {
                    state[property] = checked ? [...state[property], day].sort() : state[property].filter(value => value !== day);
                    if (state.phase === 'review') updateReviewErrors();
                }, delivery && day === 6);
                input.parentElement.querySelector('span').textContent = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'][day];
                input.parentElement.title = name;
            });
            box.append(choices);
            const presets = scheduleElement('div', null, 'adeo-schedule-day-presets');
            const apply = days => {
                state[property] = days; state.dirty = true;
                choices.querySelectorAll('input').forEach((input, day) => { input.checked = days.includes(day); });
                if (state.phase === 'review') updateReviewErrors();
            };
            button(presets, 'Будни', () => apply([0, 1, 2, 3, 4]));
            button(presets, delivery ? 'Пн–Сб' : 'Все дни', () => apply(delivery ? [0, 1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6]));
            button(presets, 'Снять выбор', () => apply([])); box.append(presets);
            if (delivery) note(box, 'Будни — круглосуточно. Суббота — до 16:00. Воскресенье — выходной. Снимите все галочки, чтобы сохранить отправки без доставки.');
            parent.append(box);
        }
        function freshTemplate() { return { uid: String(++scheduleDraftSequence), sendTime: '09:00', leadDays: 1, deliveryHour: 15, haveDelivery: true }; }
        function allDrafts() { return state.groups.filter(group => group.enabled).flatMap(group => group.entries); }
        function reviewErrors() {
            const errors = [];
            for (const group of state.groups.filter(item => item.enabled)) {
                const slots = [];
                for (const row of group.entries) {
                    errors.push(...validateScheduleDraft(row, state.deliveryDays).map(text => `${group.date}, ${row.sendTime || 'время не указано'}: ${text}`));
                    if (slots.some(slot => slot.sendTime === row.sendTime && scheduleScopesOverlap(slot.nfile, row.nfile))) errors.push(`${group.date}: повторная отправка для пересекающихся складов в ${row.sendTime}.`);
                    slots.push(row);
                }
            }
            return errors;
        }
        function updateReviewErrors() {
            for (const group of state.groups.filter(item => item.enabled)) for (const row of group.entries) {
                const box = content.querySelector(`[data-schedule-error="${row.uid}"]`);
                const errors = validateScheduleDraft(row, state.deliveryDays);
                if (group.entries.some(other => other !== row && other.sendTime === row.sendTime && scheduleScopesOverlap(other.nfile, row.nfile))) {
                    errors.push('На это время уже есть другая отправка для пересекающихся складов. Измените время или удалите лишнюю запись.');
                }
                if (box) box.textContent = errors.join(' ');
                const summary = content.querySelector(`[data-schedule-row-summary="${row.uid}"]`);
                if (summary) {
                    const haveDelivery = scheduleHasDelivery(row, state.deliveryDays);
                    const rowBox = summary.parentElement;
                    const deliveryCheck = rowBox.querySelector('[data-schedule-delivery-check]');
                    deliveryCheck.checked = haveDelivery;
                    deliveryCheck.disabled = !state.deliveryDays.length;
                    rowBox.querySelector('.adeo-schedule-row-delivery').hidden = !haveDelivery;
                    const warehouse = state.mode === 'copy' ? (scheduleNfile(row.nfile) ? ` · склад ${row.nfile}` : ' · все склады') : '';
                    summary.replaceChildren(
                        scheduleElement('span', `${row.sendTime || 'Укажите время'}${warehouse}`, 'adeo-schedule-row-time'),
                        scheduleElement('span', haveDelivery ? `${displayScheduleDay(row.deliveryDate, false)} · ${scheduleHourLabel(row.deliveryHour)}` : 'Без доставки', 'adeo-schedule-row-delivery-text')
                    );
                    if (errors.length) summary.append(scheduleElement('span', 'Требует исправления', 'adeo-schedule-row-issue'));
                    rowBox.classList.toggle('adeo-schedule-row-invalid', errors.length > 0);
                }
            }
            const summary = content.querySelector('[data-schedule-summary]');
            if (summary) {
                const count = reviewErrors().length;
                summary.querySelector('[data-schedule-summary-text]').textContent = `Записей: ${allDrafts().length}. Дней для изменения: ${state.groups.filter(group => group.enabled).length}. Замечаний: ${count}.`;
                summary.classList.toggle('has-issues', count > 0);
                summary.querySelector('button').hidden = !count;
            }
            const fixes = content.querySelector('[data-schedule-saturday-fix]');
            if (fixes) { fixes.replaceChildren(); renderSaturdayFix(fixes); }
        }
        function renderRow(parent, row, entries, template = false) {
            const box = scheduleElement(template ? 'div' : 'details', null, 'adeo-schedule-row');
            box.dataset.scheduleRow = row.uid;
            if (template) box.append(scheduleElement('span', schedulePad(entries.indexOf(row) + 1), 'adeo-schedule-row-number'));
            if (!template) {
                const summary = scheduleElement('summary'); summary.dataset.scheduleRowSummary = row.uid; box.append(summary);
                box.open = Boolean(row.expanded); box.addEventListener('toggle', () => { row.expanded = box.open; });
            }
            if (!template && state.mode === 'copy') note(box, `Склад: ${scheduleNfile(row.nfile) || 'все (общая запись)'}`);
            const update = () => { if (!template) updateReviewErrors(); };
            field(box, 'Отправка заказа', 'time', row.sendTime, value => { row.sendTime = value; update(); }, { step: '60', required: '' });
            const deliveryControls = scheduleElement('div', null, 'adeo-schedule-row-delivery');
            const haveDelivery = scheduleHasDelivery(row, state.deliveryDays);
            const deliveryCheck = check(box, 'Указать доставку', haveDelivery, value => {
                row.haveDelivery = value;
                if (!template && value && !row.deliveryDate) row.deliveryDate = nextScheduleDelivery(row.sendDate, state.deliveryDays);
                render();
            }, !state.deliveryDays.length);
            deliveryCheck.dataset.scheduleDeliveryCheck = '';
            deliveryControls.hidden = !haveDelivery;
            if (row.haveDelivery) {
                if (template) field(deliveryControls, 'Через календарных дней', 'number', row.leadDays, value => { row.leadDays = value === '' ? NaN : Number(value); }, { min: '0', step: '1', required: '' });
                else field(deliveryControls, 'Дата доставки', 'date', row.deliveryDate, value => { row.deliveryDate = value; update(); }, { min: row.sendDate, required: '' });
                select(deliveryControls, 'Интервал доставки', row.deliveryHour, Array.from({ length: 24 }, (_, hour) => ({ value: String(hour), label: scheduleHourLabel(hour) })), value => { row.deliveryHour = Number(value); update(); });
                if (!template) button(deliveryControls, 'Ближайший день доставки', () => {
                    let from = row.deliveryDate && row.deliveryDate >= row.sendDate ? row.deliveryDate : row.sendDate;
                    if (from === row.sendDate && `${schedulePad(row.deliveryHour)}:00` < row.sendTime) from = addScheduleDays(from, 1);
                    row.deliveryDate = nextScheduleDelivery(from, state.deliveryDays); state.dirty = true; render();
                });
            }
            box.append(deliveryControls);
            if (!template) { const errors = scheduleElement('div', '', 'adeo-schedule-error'); errors.dataset.scheduleError = row.uid; box.append(errors); }
            const tools = scheduleElement('div', null, 'adeo-schedule-row-tools');
            button(tools, 'Копия', () => { entries.splice(entries.indexOf(row) + 1, 0, { ...row, uid: String(++scheduleDraftSequence), expanded: true }); state.dirty = true; render(); });
            button(tools, 'Удалить', () => { entries.splice(entries.indexOf(row), 1); state.dirty = true; render(); }, 'danger');
            box.append(tools); parent.append(box);
        }
        function renderSetup() {
            select(content, 'Все новые записи', state.repeatWeekly ? 'weekly' : 'once', [
                { value: 'once', label: 'Одноразовые' },
                { value: 'weekly', label: 'С еженедельным повторением' }
            ], value => { state.repeatWeekly = value === 'weekly'; });
            note(content, 'Выбранный тип применяется ко всем новым записям. Для праздничного дня выберите одноразовые.');
            if (state.mode === 'new') {
                const box = scheduleElement('div', null, 'adeo-schedule-box'); box.append(scheduleElement('h3', '1. Склад и дата начала'));
                const fields = scheduleElement('div', null, 'adeo-schedule-form-pair');
                select(fields, 'Номер склада', scheduleNfile(state.nfile), [{ value: '', label: 'Все склады — общее правило' }, ...state.storages.map(storage => ({
                    value: String(storage.nfile), label: `${storage.nfile}${storage.name ? ` — ${storage.name}` : ''}`
                }))], value => { state.nfile = value === '' ? null : state.storages.find(storage => String(storage.nfile) === value)?.nfile ?? value; });
                field(fields, 'Начать с', 'date', state.startDate, value => { state.startDate = value; }, { min: addScheduleDays(scheduleDay(), 1) }); box.append(fields);
                note(box, 'Склад применяется ко всем записям. Если выбраны все склады, перед заменой покажем расписания каждого из них.'); content.append(box);
                const days = scheduleElement('div', null, 'adeo-schedule-setup-days');
                weekdays(days, '2. Когда отправлять заказы поставщику', 'orderDays');
                weekdays(days, '3. Когда поставщик может привезти товар', 'deliveryDays', true); content.append(days);
                button(footer, 'Далее: заполнить день', () => {
                    parseScheduleDay(state.startDate);
                    if (state.startDate <= scheduleDay()) throw new Error('Выберите дату начала не раньше завтра.');
                    if (!state.orderDays.length) throw new Error('Выберите хотя бы один день отправки.');
                    state.phase = 'template'; render();
                }, 'primary');
            } else {
                const box = scheduleElement('div', null, 'adeo-schedule-box'); box.append(scheduleElement('h3', 'Копирование еженедельных записей'));
                const fields = scheduleElement('div', null, 'adeo-schedule-form-pair');
                field(fields, 'Из какого дня', 'date', state.sourceDate, value => { state.sourceDate = value; });
                field(fields, 'В какой день', 'date', state.targetDate, value => { state.targetDate = value; }, { min: addScheduleDays(scheduleDay(), 1) }); box.append(fields);
                note(box, 'Копируются только еженедельные записи загруженного дня, со всеми исходными складами. Все даты сдвигаются на одинаковое число дней.'); content.append(box);
                weekdays(content, 'Допустимые дни доставки для проверки копии', 'deliveryDays', true);
                button(footer, 'Подготовить копию', async () => {
                    parseScheduleDay(state.sourceDate); parseScheduleDay(state.targetDate);
                    if (state.sourceDate === state.targetDate) throw new Error('Выберите другой день назначения.');
                    if (state.targetDate <= scheduleDay()) throw new Error('День назначения должен быть будущим.');
                    assertContext(); setBusy(true);
                    try {
                        const events = await adapter.list(supplierId);
                        const source = events.filter(event => isWeeklySchedule(event) && scheduleDay(event.ordersAcceptedAt) === state.sourceDate);
                        if (!source.length) throw new Error('CRM не вернула еженедельных записей для этого дня. Выберите день с загруженным расписанием.');
                        const offset = (parseScheduleDay(state.targetDate) - parseScheduleDay(state.sourceDate)) / 86400000;
                        const entries = source.map(event => scheduleEventToDraft(event, offset));
                        state.events = events; state.groups = [{ date: state.targetDate, weekday: scheduleWeekday(state.targetDate), enabled: true, repeatWeekly: state.repeatWeekly,
                            nfiles: [...new Map(entries.map(row => [scheduleNfile(row.nfile), row.nfile])).values()], entries }];
                        state.dirty = true; state.phase = 'review';
                    } finally { setBusy(false); render(); }
                }, 'primary');
            }
        }

        function renderSaturdayFix(parent) {
            const rows = allDrafts().filter(row => {
                try { return scheduleHasDelivery(row, state.deliveryDays) && row.deliveryDate && scheduleWeekday(row.deliveryDate) === 5 && row.deliveryHour > 15; }
                catch { return false; }
            });
            if (!rows.length) return;
            const box = scheduleElement('div', null, 'adeo-schedule-box'); box.append(scheduleElement('h3', `Суббота: исправить время у ${rows.length} доставок`));
            const selected = new Set(rows.map(row => row.uid));
            rows.forEach(row => check(box, `${row.sendDate} ${row.sendTime} → ${row.deliveryDate}, ${scheduleHourLabel(row.deliveryHour)}${scheduleNfile(row.nfile) ? `, склад ${row.nfile}` : ''}`, true,
                checked => checked ? selected.add(row.uid) : selected.delete(row.uid)));
            let hour = '';
            select(box, 'Общий интервал для выбранных записей', '', [{ value: '', label: 'Выберите интервал' }, ...Array.from({ length: 16 }, (_, value) => ({ value: String(value), label: scheduleHourLabel(value) }))], value => { hour = value; });
            button(box, 'Применить к выбранным', () => {
                if (hour === '') throw new Error('Выберите субботний интервал.');
                rows.filter(row => selected.has(row.uid)).forEach(row => { row.deliveryHour = Number(hour); }); state.dirty = true; render();
            }); parent.append(box);
        }

        function renderReview() {
            note(content, state.repeatWeekly ? 'Все новые записи: с еженедельным повторением.' : 'Все новые записи: одноразовые.');
            note(content, state.mode === 'copy' ? 'Проверьте копию перед сохранением. Нажмите на запись, чтобы изменить время или доставку.' : 'У каждого дня указана первая дата отправки. Раскройте запись для редактирования; изменения сохранятся после общей проверки.');
            if (state.mode === 'copy') {
                const settings = scheduleElement('details', null, 'adeo-schedule-settings');
                settings.append(scheduleElement('summary', 'Дни доставки и часы приёмки · изменить'));
                weekdays(settings, 'Разрешённые дни доставки', 'deliveryDays', true); content.append(settings);
            }
            const summary = scheduleElement('div', null, 'adeo-schedule-summary'); summary.dataset.scheduleSummary = '';
            const stats = scheduleElement('span'); stats.dataset.scheduleSummaryText = ''; summary.append(stats);
            button(summary, 'К первой ошибке', () => {
                const row = content.querySelector('.adeo-schedule-row-invalid');
                if (!row) return;
                row.open = true; row.scrollIntoView({ block: 'center', behavior: 'smooth' });
                row.querySelector('input')?.focus({ preventScroll: true });
            }); content.append(summary);
            const fixes = scheduleElement('div'); fixes.dataset.scheduleSaturdayFix = ''; content.append(fixes);
            const grid = scheduleElement('div', null, `adeo-schedule-grid${state.mode === 'copy' ? ' copy' : ''}`);
            for (const group of state.groups) {
                const day = scheduleElement('section', null, 'adeo-schedule-day'); const dayHeader = scheduleElement('header', SCHEDULE_WEEKDAYS[group.weekday]);
                day.dataset.enabled = String(group.enabled);
                dayHeader.append(scheduleElement('small', `${displayScheduleDay(group.date)} · ${scheduleEntryCount(group.entries.length)}`)); const body = scheduleElement('div', null, 'adeo-schedule-day-body');
                if (state.mode === 'new') check(body, 'Изменять этот день', group.enabled, checked => { group.enabled = checked; state.dirty = true; render(); });
                if (group.enabled) {
                    const actions = scheduleElement('div', null, 'adeo-schedule-day-actions');
                    const add = button(actions, '＋ Добавить запись', () => {
                        const haveDelivery = state.deliveryDays.length > 0;
                        const deliveryDate = haveDelivery ? nextScheduleDelivery(addScheduleDays(group.date, 1), state.deliveryDays) : '';
                        group.entries.push({ uid: String(++scheduleDraftSequence), nfile: state.mode === 'new' ? state.nfile : group.nfiles[0],
                            sendDate: group.date, sendTime: '09:00', haveDelivery, deliveryDate, deliveryHour: 15, expanded: true }); state.dirty = true; render();
                    });
                    add.setAttribute('aria-label', '＋ Добавить запись'); add.textContent = '＋ Запись'; add.title = 'Добавить запись в этот день';
                    if (state.mode === 'new') {
                        const nextDay = state.groups.find(item => item.date === addScheduleDays(group.date, 1));
                        if (nextDay) {
                            const next = button(actions, 'На следующий день', () => requestDraftCopy(group, nextDay));
                            next.setAttribute('aria-label', 'На следующий день'); next.textContent = 'Копия →'; next.title = `Скопировать в ${SCHEDULE_WEEKDAYS[nextDay.weekday].toLowerCase()}, ${displayScheduleDay(nextDay.date)}`;
                        }
                        body.append(actions);
                        const copy = scheduleElement('details', null, 'adeo-schedule-copy-tools'); copy.append(scheduleElement('summary', 'В другой день…'));
                        let target = '';
                        select(copy, 'Скопировать весь день в', '', [{ value: '', label: 'Выберите день' }, ...state.groups.filter(item => item !== group).map(item => ({ value: item.date, label: `${SCHEDULE_WEEKDAYS[item.weekday]} ${displayScheduleDay(item.date)}` }))], value => { target = value; });
                        button(copy, 'Копировать день', () => {
                            const destination = state.groups.find(item => item.date === target);
                            if (!destination) throw new Error('Выберите день назначения.');
                            requestDraftCopy(group, destination);
                        }); body.append(copy);
                    } else body.append(actions);
                    if (!group.entries.length) note(body, 'Нет отправок. При замене существующее расписание этого дня будет очищено.');
                    group.entries.forEach(row => renderRow(body, row, group.entries));
                }
                day.append(dayHeader, body); grid.append(day);
            }
            content.append(grid); updateReviewErrors();
            button(footer, 'Назад', () => { state.phase = state.mode === 'new' ? 'template' : 'setup'; render(); });
            button(footer, 'Сохранить всё', prepareSave, 'primary');
        }

        function requestDraftCopy(source, destination) {
            if (destination.entries.length) { renderDraftCopyChoice(source, destination); return; }
            destination.entries = copyScheduleDrafts(source.entries, source.date, destination.date);
            destination.enabled = true; state.dirty = true; render();
        }

        function renderDraftCopyChoice(source, destination) {
            modal.dataset.view = 'copy-choice';
            content.replaceChildren(); footer.replaceChildren(); content.append(errorBox);
            content.append(scheduleElement('h3', `${SCHEDULE_WEEKDAYS[destination.weekday]}, ${displayScheduleDay(destination.date)} — день уже заполнен`));
            note(content, 'Выберите, как скопировать записи. В CRM ничего не изменится до общего сохранения.');
            const copy = replace => {
                const copied = copyScheduleDrafts(source.entries, source.date, destination.date);
                destination.entries = replace ? copied : [...destination.entries, ...copied]; destination.enabled = true; state.dirty = true; render();
            };
            button(footer, 'Отмена', render); button(footer, 'Добавить', () => copy(false)); button(footer, 'Заменить', () => copy(true), 'primary');
        }

        async function prepareSave() {
            const errors = reviewErrors(); if (errors.length) throw new Error(`Перед сохранением исправьте замечания: ${errors.length}. Раскройте выделенные записи или нажмите «К первой ошибке».`);
            if (!state.groups.some(group => group.enabled)) throw new Error('Выберите хотя бы один день для изменения.');
            assertContext(); setBusy(true);
            try {
                state.events = await adapter.list(supplierId); state.snapshot = scheduleFingerprint(state.events); state.decisions = {};
                state.phase = 'confirm';
            } finally { setBusy(false); render(); }
        }

        function scheduleTable(parent, rows) {
            const wrapper = scheduleElement('div', null, 'adeo-schedule-table-wrap');
            const table = scheduleElement('table', null, 'adeo-schedule-table');
            const head = scheduleElement('thead'), headings = scheduleElement('tr');
            for (const name of ['Отправка', 'Склад', 'Доставка', 'Запись']) { const cell = scheduleElement('th', name); cell.scope = 'col'; headings.append(cell); }
            head.append(headings); const body = scheduleElement('tbody');
            for (const { event, label } of rows) {
                const row = scheduleElement('tr');
                const delivery = event.orderDeliveryIntervalStart ? `${displayScheduleDay(scheduleDay(event.orderDeliveryIntervalStart))} · ${scheduleTime(event.orderDeliveryIntervalStart)}–${scheduleTime(event.orderDeliveryIntervalEnd)}` : 'Без доставки';
                for (const value of [`${displayScheduleDay(scheduleDay(event.ordersAcceptedAt))} · ${scheduleTime(event.ordersAcceptedAt)}`, scheduleNfile(event.nfile) || 'Все', delivery, label]) row.append(scheduleElement('td', value));
                body.append(row);
            }
            table.append(head, body); wrapper.append(table); parent.append(wrapper);
        }

        function renderConfirm() {
            const conflicts = findScheduleConflicts(state.events, state.groups).filter(item => item.count);
            content.append(scheduleElement('h3', 'Проверка перед сохранением'));
            note(content, state.repeatWeekly
                ? 'Все новые записи будут повторяться еженедельно. «Заменить» прекращает показанные прежние повторы с указанной будущей даты и удаляет разовые записи этой даты в затронутых складах. Прошедшие даты сохраняются.'
                : 'Все новые записи одноразовые, только на указанные даты. «Заменить» удаляет только показанные отправки этих дат; еженедельные повторы на другие даты сохраняются.');
            if (state.groups.some(group => group.enabled && group.nfiles.some(value => scheduleNfile(value) === ''))) {
                note(content, state.repeatWeekly
                    ? 'Выбраны все склады: замена включает правила отдельных складов выбранных дней недели. Проверьте их список перед подтверждением.'
                    : 'Выбраны все склады: замена включает отправки отдельных складов только на выбранные даты. Проверьте их список перед подтверждением.');
            }
            if (!conflicts.length) note(content, 'Существующих записей в выбранных днях и складах не найдено. Можно сохранить подготовленное расписание.');
            else {
                const bulk = scheduleElement('div', null, 'adeo-schedule-bulkbar');
                bulk.append(scheduleElement('span', 'Для всех дней с конфликтами:'));
                const canReplace = conflict => !scheduleReplacesGeneralRule(conflict) && conflict.weekly.every(series => Boolean(series.first));
                for (const [value, label] of [['add', 'Везде добавить'], ['replace', 'Везде заменить'], ['skip', 'Везде пропустить']]) {
                    const control = button(bulk, label, () => { conflicts.forEach(item => { state.decisions[item.group.date] = value; }); render(); });
                    if (value === 'replace' && conflicts.some(item => !canReplace(item))) { control.disabled = true; control.title = 'Для части дней замена недоступна. Причина указана в карточке дня.'; }
                }
                content.append(bulk);
                for (const conflict of conflicts) {
                    const box = scheduleElement('div', null, 'adeo-schedule-conflict');
                    const top = scheduleElement('div', null, 'adeo-schedule-conflict-head');
                    top.append(scheduleElement('strong', `${SCHEDULE_WEEKDAYS[scheduleWeekday(conflict.group.date)]}\nс ${displayScheduleDay(conflict.group.date)}`));
                    top.append(scheduleElement('span', `Существующих правил: ${conflict.count}. Новых записей: ${conflict.group.entries.length}.`, 'adeo-schedule-note'));
                    select(top, 'Действие', state.decisions[conflict.group.date] || '', [
                        { value: '', label: 'Выберите действие' }, { value: 'add', label: 'Добавить' }, { value: 'replace', label: 'Заменить', disabled: !canReplace(conflict) }, { value: 'skip', label: 'Пропустить день' }
                    ], value => { state.decisions[conflict.group.date] = value; }); box.append(top);
                    const active = [...conflict.weekly.filter(series => series.first).map(series => ({ event: series.first, label: 'Еженедельно' })),
                        ...conflict.once.map(event => ({ event, label: isWeeklySchedule(event) ? 'Еженедельная · только эта дата' : 'Разовая' }))];
                    if (active.length) {
                        const details = scheduleElement('details', null, 'adeo-schedule-conflict-details'); details.open = conflicts.length === 1;
                        details.append(scheduleElement('summary', `Будущие записи · ${active.length}`)); scheduleTable(details, active); box.append(details);
                    }
                    const unavailable = conflict.weekly.filter(series => !series.first);
                    if (unavailable.length) {
                        box.append(scheduleElement('p', `Для ${unavailable.length} действующих правил CRM не вернула экземпляр начиная с выбранной даты. Замена этого дня пока недоступна; выберите дату ближе или пропустите день.`, 'adeo-schedule-warning'));
                        const details = scheduleElement('details', null, 'adeo-schedule-conflict-details');
                        details.append(scheduleElement('summary', `Действующие правила без экземпляра на выбранную дату · ${unavailable.length}`));
                        scheduleTable(details, unavailable.map(series => ({ event: series.instances.at(-1), label: 'Нет экземпляра на дату' }))); box.append(details);
                    }
                    if (conflict.historical.length) {
                        const details = scheduleElement('details', null, 'adeo-schedule-conflict-details adeo-schedule-history');
                        details.append(scheduleElement('summary', `История · ${conflict.historical.length} правил без будущих отправок (не изменяется)`));
                        note(details, 'Эти записи относятся к прошедшим датам. Они не участвуют в замене и не блокируют её.');
                        scheduleTable(details, conflict.historical.map(series => ({ event: series.instances.at(-1), label: 'Только история' }))); box.append(details);
                    }
                    if (scheduleReplacesGeneralRule(conflict)) box.append(scheduleElement('p', 'Общее правило действует на все склады. Его удаление при замене только одного склада заблокировано.', 'adeo-schedule-warning'));
                    content.append(box);
                }
            }
            button(footer, 'Отмена — к черновику', () => { state.phase = 'review'; render(); });
            button(footer, 'Подтвердить сохранение', commitSave, 'primary');
        }

        async function prepareClear() {
            assertContext(); setBusy(true);
            try {
                const events = await adapter.list(supplierId);
                makeScheduleClearPlan(events, supplierId);
                state.events = events; state.snapshot = scheduleFingerprint(events);
                state.mode = 'clear'; state.phase = 'clear-confirm';
            } finally { setBusy(false); render(); }
        }

        function renderClearConfirm() {
            const plan = makeScheduleClearPlan(state.events, supplierId);
            content.append(scheduleElement('h3', 'Очистка всего будущего расписания'));
            note(content, `Поставщик: ${proxy.supplier.cella || supplierId}. Все склады, начиная с ${displayScheduleDay(addScheduleDays(scheduleDay(), 1))}.`);
            note(content, 'Будут удалены разовые отправки и прекращены все показанные еженедельные повторы. Сегодняшние и прошедшие записи сохранятся.');
            content.append(scheduleElement('p', `Еженедельных правил: ${plan.ruleCount}. Разовых записей: ${plan.onceCount}. Будущих отправок в загруженном расписании: ${plan.futureCount}.`, 'adeo-schedule-summary'));
            if (plan.operations.length) scheduleTable(content, plan.operations.map(operation => ({ event: operation.event, label: operation.future ? 'Прекратить повторы' : 'Удалить разовую' })));
            if (!plan.operations.length) note(content, 'В загруженном расписании нет будущих записей для удаления.');
            button(footer, 'Отмена', close);
            if (plan.operations.length) button(footer, 'Подтвердить очистку всех складов', commitClear, 'danger');
        }

        async function commitClear() {
            assertContext();
            const job = makeScheduleClearPlan(state.events, supplierId);
            if (!job.operations.length) throw new Error('Будущих записей для удаления нет.');
            setBusy(true);
            try {
                const latest = await adapter.list(supplierId);
                if (scheduleFingerprint(latest) !== state.snapshot) {
                    state.events = latest; state.snapshot = scheduleFingerprint(latest); render();
                    throw new Error('Расписание изменилось после открытия окна очистки. Проверьте обновлённый список и подтвердите очистку заново.');
                }
                state.job = job; state.dirty = true; state.phase = 'saving'; render();
                await executeJob();
            } finally { setBusy(false); render(); }
        }

        async function commitSave() {
            assertContext();
            const job = makeSchedulePlan(state.events, state.groups, state.decisions, supplierId, state.deliveryDays);
            if (state.mode === 'copy') job.copyDrafts = state.groups.filter(group => group.enabled && state.decisions[group.date] !== 'skip')
                .flatMap(group => group.entries.map(draft => ({ ...draft, haveDelivery: scheduleHasDelivery(draft, state.deliveryDays) })));
            setBusy(true);
            try {
                const latest = await adapter.list(supplierId);
                if (scheduleFingerprint(latest) !== state.snapshot) {
                    state.events = latest; state.snapshot = scheduleFingerprint(latest); state.decisions = {}; render();
                    throw new Error('За время проверки расписание в CRM изменилось. Проверьте обновлённые конфликты и снова выберите действия.');
                }
                state.job = job; state.phase = 'saving'; render();
                await executeJob();
            } finally { setBusy(false); render(); }
        }

        async function executeJob() {
            try {
                await runSchedulePlan(state.job, adapter, assertContext, renderProgress);
                if (state.job.clearing) {
                    const remaining = await adapter.list(supplierId);
                    if (remaining.some(event => scheduleDay(event.ordersAcceptedAt) > scheduleDay())) {
                        throw new Error('После очистки CRM всё ещё возвращает будущие записи. Очистка не подтверждена полностью. Проверьте результат; новые или оставшиеся записи автоматически не удаляются.');
                    }
                }
                if (state.job.copyDrafts) {
                    const events = await adapter.list(supplierId);
                    const missing = missingScheduleCopies(events, state.job.copyDrafts, supplierId);
                    if (missing.length) throw new Error(state.repeatWeekly
                        ? 'CRM не вернула часть копий на выбранную дату. Еженедельные записи могут пропускать праздники. Проверьте календарь; для праздничной даты выберите одноразовые записи в начале мастера.'
                        : 'CRM не подтвердила появление части одноразовых копий на выбранную дату. Обновите календарь и проверьте результат.');
                }
                state.phase = 'done'; state.dirty = false;
                try { await proxy.loadSchedules(); } catch { state.error = 'Изменения выполнены, но календарь не обновился. Нажмите штатную кнопку обновления календаря.'; }
            } catch (error) { state.phase = 'failed'; state.error = error?.message || 'Не удалось завершить сохранение.'; }
        }

        function renderProgress() {
            const label = content.querySelector('[data-schedule-progress-label]');
            if (label) label.textContent = `Выполнено ${state.job.index} из ${state.job.operations.length}. Создано: ${state.job.created}, удалено: ${state.job.deleted}.`;
            const progress = content.querySelector('progress'); if (progress) progress.value = state.job.index;
        }

        function renderJob() {
            const job = state.job;
            const title = job.clearing
                ? (state.phase === 'done' ? 'Будущее расписание очищено' : state.phase === 'failed' ? 'Очистка остановлена' : 'Очистка расписания')
                : (state.phase === 'done' ? 'Расписание сохранено' : state.phase === 'failed' ? 'Сохранение остановлено' : 'Сохранение расписания');
            content.append(scheduleElement('h3', title));
            const label = scheduleElement('p'); label.dataset.scheduleProgressLabel = ''; label.setAttribute('role', 'status'); label.setAttribute('aria-live', 'polite'); content.append(label);
            const progress = scheduleElement('progress', null, 'adeo-schedule-progress'); progress.max = job.operations.length || 1; progress.value = job.index; content.append(progress); renderProgress();
            if (job.skipped) note(content, `Одинаковых записей уже было в CRM: ${job.skipped}. Повторно они не создавались.`);
            if (state.phase === 'done') button(footer, 'Закрыть', close, 'primary');
            if (state.phase === 'failed') {
                note(content, 'Уже выполненные изменения сохранены в CRM. Повторная отправка неподтверждённого запроса автоматически не выполняется, чтобы не создавать дубли.');
                button(footer, 'Проверить результат и продолжить', async () => {
                    assertContext(); setBusy(true);
                    try {
                        if (!await reconcileSchedulePlan(job, adapter, supplierId)) throw new Error('CRM пока не подтверждает результат последней операции. Продолжение заблокировано. Обновите календарь и сверьте расписание; не запускайте тот же черновик повторно без проверки.');
                        state.phase = 'saving'; render(); await executeJob();
                    } finally { setBusy(false); render(); }
                }, 'primary');
            }
        }

        function renderNavigation() {
            steps.replaceChildren();
            steps.hidden = ['choose', 'loading', 'load-error'].includes(state.phase);
            if (steps.hidden) return;
            const stages = state.mode === 'new'
                ? ['Параметры', 'Шаблон дня', 'Неделя', 'Сохранение']
                : state.mode === 'clear' ? ['Проверка записей', 'Очистка'] : ['Даты', 'Проверка копии', 'Сохранение'];
            const current = state.mode === 'clear' ? (state.phase === 'clear-confirm' ? 0 : 1)
                : state.phase === 'setup' ? 0 : state.phase === 'template' ? 1 : state.phase === 'review' ? (state.mode === 'new' ? 2 : 1) : stages.length - 1;
            stages.forEach((label, index) => {
                const item = scheduleElement('span', null, `adeo-schedule-step${index === current ? ' current' : index < current ? ' done' : ''}`);
                item.append(scheduleElement('b', String(index + 1)), scheduleElement('span', label));
                if (index === current) item.setAttribute('aria-current', 'step'); steps.append(item);
            });
        }

        function render() {
            const previousPhase = modal.dataset.phase;
            modal.dataset.phase = state.phase; modal.dataset.mode = state.mode; modal.dataset.view = '';
            renderNavigation();
            content.replaceChildren(); footer.replaceChildren(); errorBox.textContent = state.error; content.append(errorBox);
            if (state.phase === 'loading') { note(content, 'Загружаем расписание и склады выбранного поставщика…'); return; }
            if (state.phase === 'load-error') { note(content, 'Не удалось загрузить данные CRM. Закройте мастер и попробуйте снова.'); return; }
            if (state.phase === 'choose') {
                note(content, 'Выберите действие для текущего поставщика.'); const modes = scheduleElement('div', null, 'adeo-schedule-mode');
                for (const [mode, title, description] of [['copy', 'Скопировать день', 'Перенести все еженедельные записи конкретного дня на другую дату.'], ['new', 'Заполнить с нуля', 'Выбрать дни, заполнить один день и подготовить всю неделю.']]) {
                    const node = button(modes, title, () => { state.mode = mode; state.phase = 'setup'; render(); });
                    const icon = scheduleElement('span', mode === 'copy' ? '↪' : '＋', 'adeo-schedule-mode-icon'); icon.setAttribute('aria-hidden', 'true');
                    node.replaceChildren(icon, scheduleElement('strong', title), scheduleElement('small', description));
                }
                content.append(modes);
                const dangerZone = scheduleElement('div', null, 'adeo-schedule-danger-zone');
                note(dangerZone, 'Нужно удалить будущие отправки? Очистка доступна отдельно и требует подтверждения.');
                button(dangerZone, 'Очистить всё расписание', prepareClear, 'danger'); content.append(dangerZone); return;
            }
            if (state.phase === 'setup') { button(footer, 'Назад', () => { state.phase = 'choose'; render(); }); renderSetup(); }
            else if (state.phase === 'template') {
                content.append(scheduleElement('h3', 'Заполните один день отправок'));
                note(content, 'Каждая строка — одна отправка. Срок считается в календарных днях; выходные доставки учтём при заполнении недели.');
                const toolbar = scheduleElement('div', null, 'adeo-schedule-toolbar');
                toolbar.append(scheduleElement('strong', `Записей в шаблоне: ${state.template.length}`));
                button(toolbar, '＋ Добавить запись', () => { state.template.push(freshTemplate()); state.dirty = true; render(); }); content.append(toolbar);
                const rows = scheduleElement('div', null, 'adeo-schedule-template'); state.template.forEach(row => renderRow(rows, row, state.template, true)); content.append(rows);
                button(footer, 'Назад', () => { state.phase = 'setup'; render(); });
                button(footer, 'Заполнить выбранные дни', () => {
                    if (state.groups.length && !window.confirm('Сформировать неделю заново? Индивидуальные правки дней будут заменены шаблоном.')) return;
                    state.groups = buildScheduleWeek(state.template, state.orderDays, state.deliveryDays, state.startDate, state.nfile)
                        .map(group => ({ ...group, repeatWeekly: state.repeatWeekly }));
                    state.dirty = true; state.phase = 'review'; render();
                }, 'primary');
            } else if (state.phase === 'review') renderReview();
            else if (state.phase === 'confirm') renderConfirm();
            else if (state.phase === 'clear-confirm') renderClearConfirm();
            else renderJob();
            if (previousPhase !== state.phase) { content.scrollTop = 0; content.scrollLeft = 0; }
        }
        render();
        try {
            assertContext();
            state.events = await adapter.list(supplierId);
            state.storages = Array.isArray(proxy.storages) ? [...proxy.storages] : [];
            if (state.mode !== 'clear' && !state.storages.length && typeof proxy.$svcPlatformV1Client === 'function') {
                const response = await proxy.$svcPlatformV1Client({ url: '/b2b/supplier/storage/search', method: 'POST', data: { isDisabled: false, supplierId } });
                if (!Array.isArray(response?.data?.content)) throw new Error('CRM вернула неизвестный список складов.');
                state.storages = response.data.content;
            }
            state.storages = state.storages.filter(storage => storage.nfile !== null && storage.nfile !== undefined);
            if (state.mode === 'clear') {
                makeScheduleClearPlan(state.events, supplierId); state.snapshot = scheduleFingerprint(state.events); state.phase = 'clear-confirm';
            } else state.phase = 'choose';
        } catch (error) { state.phase = 'load-error'; state.error = error.message; }
        if (overlay.isConnected) render();
    }

    // Расчёт конкурентоспособности повторяет O1:V2 макроса, не меняя исходную книгу.
    function calculateMarketabilityWorkbook(workbook, XLSX, Decimal, progress = () => {}) {
        const normalize = value => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
        let structure = null;
        for (const name of workbook.SheetNames) {
            const sheet = workbook.Sheets[name];
            if (!sheet?.['!ref']) continue;
            const end = XLSX.utils.decode_range(sheet['!ref']).e;
            for (let row = 0; row <= Math.min(9, end.r); row++) {
                const headers = new Map();
                for (let col = 0; col <= end.c; col++) {
                    const header = normalize(sheet[XLSX.utils.encode_cell({ r: row, c: col })]?.v);
                    if (header) headers.set(header, col);
                }
                if (headers.has('позиция') && headers.has('артикул') && headers.has('бренд')) {
                    structure = { sheet, name, header: row, end: end.r, position: headers.get('позиция'), article: headers.get('артикул') };
                    break;
                }
            }
            if (structure) break;
        }
        if (!structure) throw new Error('Не найдена таблица с колонками «Позиция», «Артикул» и «Бренд». Нужен исходный отчёт конкурентоспособности CRM.');
        const value = (row, col) => structure.sheet[XLSX.utils.encode_cell({ r: row, c: col })]?.v;
        let top1 = 0, unique = 0, top2 = 0, top3 = 0, total = 0, invalid = 0, uniqueSection = false;
        const warnings = [];
        const rows = structure.end - structure.header;
        for (let row = structure.header + 1; row <= structure.end; row++) {
            const processed = row - structure.header;
            if (processed === 1 || processed % 1000 === 0 || processed === rows) progress(processed, rows);
            const raw = value(row, structure.position);
            const positionText = normalize(raw);
            if (positionText === 'уникальные позиции') { uniqueSection = true; continue; }
            const article = value(row, structure.article);
            if (!positionText && (article === undefined || article === null || article === '')) continue;
            // Числовая позиция — запись отчёта; неизвестный ранг со SKU учитываем в знаменателе с замечанием.
            const rank = positionText && typeof raw !== 'boolean' ? Number(positionText.replace(',', '.')) : NaN;
            if (!Number.isInteger(rank) || rank < 1 || rank > 999) {
                if (article === undefined || article === null || article === '') continue;
                total++; invalid++;
                if (warnings.length < 100) warnings.push(`Строка ${row + 1}: не удалось определить позицию. Строка включена в общее количество, но не в топ.`);
                continue;
            }
            total++;
            if (uniqueSection || rank === 999) unique++;
            else if (rank === 1) top1++;
            else if (rank === 2) top2++;
            else if (rank === 3) top3++;
        }
        if (!total) throw new Error('В отчёте не найдены позиции для анализа.');
        const passed = top1 + unique;
        // Целевой порог — ровно 30%. Целочисленная разница исключает ошибки округления на границе.
        const gap = 3 * total - 10 * passed;
        const percent = new Decimal(passed).div(total).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
        return { result: { top1, unique, top2, top3, total, percent, passed, target: 30, meetsTarget: gap <= 0,
            discountRows: gap > 0 ? Math.ceil(gap / 10) : null, removeRows: gap > 0 ? Math.ceil(gap / 3) : null },
            meta: { sheet: structure.name, invalidRows: invalid, scannedRows: rows }, warnings };
    }

    function renderMarketabilitySummary(metrics, notes, report) {
        metrics.replaceChildren();
        notes.replaceChildren();
        if (!report) return;
        const element = (tag, className, text = '') => {
            const node = document.createElement(tag);
            node.className = className;
            node.textContent = text;
            return node;
        };
        const data = report.result;
        const formatter = new Intl.NumberFormat('ru-RU');
        const number = value => value === null ? '—' : formatter.format(value);
        const items = [['Топ 1', number(data.top1)], ['Уник', number(data.unique)], ['Топ 2', number(data.top2)], ['Топ 3', number(data.top3)],
            ['Всего строк', number(data.total)], ['% прохождения', `${data.percent.replace('.', ',')}%`],
            ['Скидка строк', number(data.discountRows)], ['Убрать строк', number(data.removeRows)]];
        items.forEach(([label, value], index) => {
            const metric = element('article', 'adeo-marketability-metric');
            metric.append(element('span', '', label), element('strong', '', value));
            if (index === 5) metric.dataset.target = data.meetsTarget ? 'met' : 'below';
            if (index === 6) metric.title = 'Сколько позиций нужно улучшить до топ-1, чтобы достичь 30% прохождения.';
            if (index === 7) metric.title = 'Сколько непроходящих позиций нужно исключить, чтобы достичь 30% прохождения.';
            metrics.append(metric);
        });
        notes.append(element('div', 'adeo-marketability-note', `Цель: 30%. Прохождение = (Топ 1 + Уник) / Всего строк. ${data.meetsTarget ? 'Целевой порог достигнут.' : '«Скидка строк» и «Убрать строк» — альтернативные способы достичь цели.'} Уникальные позиции не включены повторно в Топ 1. Лист: ${report.meta.sheet}.`));
        if (report.warnings.length) {
            const details = element('details', '');
            details.append(element('summary', '', `Замечания к позициям: ${number(report.meta.invalidRows)}`));
            const list = element('ul', '');
            report.warnings.forEach(text => list.append(element('li', '', text)));
            details.append(list);
            notes.append(details);
        }
    }

    function installMarketabilityStyles() {
        if (document.getElementById('adeo-marketability-styles')) return;
        const style = document.createElement('style'); style.id = 'adeo-marketability-styles';
        style.textContent = `
            .adeo-marketability.marketability { max-width: none; width: 100%; padding: 20px; gap: 18px; overflow-y: auto; box-sizing: border-box; }
            .adeo-marketability > form { display: grid !important; width: 100%; max-width: 1200px; margin: 0 auto; box-sizing: border-box; grid-template-columns: repeat(2, minmax(0, 1fr)); align-content: start; flex: 0 0 auto; padding: 16px 20px; border: 1px solid var(--ap-borders-color, #d8e0e8); border-radius: 10px; background: var(--ap-background-color, #fff); gap: 10px 24px !important; }
            .adeo-marketability > form > :not(.marketability__row) { grid-column: 1 / -1; }
            .adeo-marketability .marketability__row { display: grid; grid-template-columns: 145px minmax(0, 1fr); align-items: center; align-content: center; min-height: 40px; gap: 12px; padding: 2px 0; }
            .adeo-marketability .marketability__col { flex: initial; width: auto; min-width: 0; align-items: center; gap: 10px; }
            .adeo-marketability .marketability__col:last-child { flex-wrap: wrap; }
            .adeo-marketability .marketability__row > .crm-switch:only-child { grid-column: 1 / -1; }
            .adeo-marketability .marketability__row > .crm-switch { max-width: 100%; }
            .adeo-marketability .crm-switch__button { flex-shrink: 0; }
            .adeo-marketability .crm-switch > .crm-input-sm { white-space: normal; line-height: 1.5; }
            .adeo-marketability form .q-field { max-width: 100%; }
            .adeo-marketability form > .full-width { padding-top: 12px; border-top: 1px solid var(--ap-borders-color, #d8e0e8); }
            .adeo-marketability form button[type=submit] { min-height: 38px; border-radius: 6px; }
            .adeo-marketability .marketability__log { width: 100%; max-width: 1200px; box-sizing: border-box; margin: 0 auto; padding: 16px; border: 1px solid var(--ap-borders-color, #d8e0e8); border-radius: 10px; background: var(--ap-background-color, #fff); flex: 0 0 auto; min-width: 0; overflow: visible; }
            .adeo-marketability .q-table__top { padding-bottom: 12px; gap: 8px; }
            .adeo-marketability .q-table__title { font-size: 17px; font-weight: 600; }
            .adeo-marketability .q-table__middle { max-height: 65vh; overflow: auto; }
            .adeo-marketability table.q-table { width: 100%; }
            .adeo-marketability .q-table th { background: var(--ap-background-color, #fff); padding: 10px 12px; }
            .adeo-marketability .q-table > tbody > tr:not(.adeo-marketability-detail) > td { padding: 12px; white-space: normal; vertical-align: middle; border-bottom: 1px solid var(--ap-borders-color, #e1e7ed); }
            .adeo-marketability .q-table > tbody > tr:not(.adeo-marketability-detail):hover > td { background: var(--ap-hover-background-color, #f4f7fb); }
            .adeo-marketability .q-table thead th:last-child { width: 200px; text-align: center; }
            .adeo-marketability .q-table td.adeo-marketability-report { position: relative; white-space: nowrap !important; width: 200px; min-width: 175px; height: 64px; text-align: center; }
            /* CRM может вставить ссылку после нашей кнопки: места действий не зависят от порядка узлов Vue. */
            .adeo-marketability .adeo-marketability-report > :not(.adeo-marketability-launch) { position: absolute !important; top: 50%; left: calc(50% - 70px); transform: translateY(-50%); display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; width: 36px !important; height: 36px; min-width: 36px; margin: 0 !important; }
            .adeo-marketability .adeo-marketability-report > button.adeo-marketability-launch { position: absolute; top: 50%; left: calc(50% - 26px); transform: translateY(-50%); box-sizing: border-box; width: 96px; height: 36px; margin: 0; }
            .adeo-marketability button.adeo-marketability-button { box-sizing: border-box; min-height: 36px; padding: 6px 12px; border: 1px solid #b7c9da; border-radius: 5px; background: #fff; color: #245d8d; font: 14px/1.4 Arial, sans-serif; cursor: pointer; white-space: nowrap; }
            .adeo-marketability button.adeo-marketability-button:hover:not(:disabled) { background: #eaf2fb; border-color: #7a9fbe; }
            .adeo-marketability button.adeo-marketability-button:focus-visible { outline: 2px solid #3274b5; outline-offset: 2px; }
            .adeo-marketability button.adeo-marketability-button:disabled { opacity: .5; cursor: default; }
            .adeo-marketability-detail > td { padding: 0 0 14px !important; border: 0; white-space: normal !important; height: auto !important; }
            .adeo-marketability-result { padding: 16px; background: #f5f8fc; border: 1px solid #d8e3ef; border-radius: 8px; color: #26394d; font: 14px/1.5 Arial, sans-serif; min-width: 0; }
            .adeo-marketability-result[data-phase=error] { border-color: #dfb9b3; }
            .adeo-marketability-heading, .adeo-marketability-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; }
            .adeo-marketability-heading { justify-content: space-between; }
            .adeo-marketability-result h3 { font: bold 16px/1.5 Arial, sans-serif; margin: 0; }
            .adeo-marketability-caption { color: #597086; margin: 4px 0 10px; overflow-wrap: anywhere; }
            .adeo-marketability-time { color: #597086; font-size: 12px; }
            .adeo-marketability-status { margin: 6px 0; }
            .adeo-marketability-result[data-phase=error] .adeo-marketability-status { color: #963c36; }
            .adeo-marketability-progress { display: block; width: 100%; height: 8px; margin: 8px 0 12px; accent-color: #3274b5; }
            .adeo-marketability-controls { margin-top: 12px; }
            .adeo-marketability-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
            .adeo-marketability-metric { background: #fff; border: 1px solid #d8e0e8; border-radius: 6px; padding: 12px; min-width: 0; }
            .adeo-marketability-metric span { display: block; color: #597086; }
            .adeo-marketability-metric strong { display: block; margin-top: 5px; font-size: 22px; overflow-wrap: anywhere; }
            .adeo-marketability-metric[data-target=met] { background: #edf8f1; border-color: #a8cbb6; }
            .adeo-marketability-metric[data-target=below] { background: #fff9ed; border-color: #e4d5af; }
            .adeo-marketability-note { margin-top: 12px; color: #597086; font-size: 12px; }
            .adeo-marketability-result details { margin-top: 10px; }
            .adeo-marketability-result summary { cursor: pointer; color: #8b6334; }
            .adeo-marketability-result ul { max-height: 180px; overflow: auto; padding-left: 22px; }
            .adeo-marketability [hidden] { display: none !important; }
            @media (min-width: 1101px) {
                .adeo-marketability > form > .marketability__row:has(input[aria-label="Прайс"]) { grid-column: 1; grid-row: 2; }
                .adeo-marketability > form > .marketability__row:has(input[aria-label="c"]) { grid-column: 1; grid-row: 3; }
                .adeo-marketability > form > .marketability__row:has(input[aria-label="ID"]) { grid-column: 1; grid-row: 4; }
                .adeo-marketability > form > .marketability__row:has(.crm-switch[aria-label^="Уникальные позиции"]) { grid-column: 2; grid-row: 2; }
                .adeo-marketability > form > .marketability__row:has(.crm-switch[aria-label^="Включать в анализ прайсы заграничных"]) { grid-column: 2; grid-row: 3; }
                .adeo-marketability > form > .marketability__row:has(.crm-switch[aria-label^="Включить в отчет только детали"]) { grid-column: 2; grid-row: 4; grid-template-columns: minmax(0, 1fr) 248px; }
                .adeo-marketability > form > .marketability__row:has(.crm-switch[aria-label^="Добавить наценку"]) { grid-column: 2; grid-row: 5; grid-template-columns: minmax(0, 1fr) 248px; }
            }
            @media (max-width: 1100px) { .adeo-marketability > form { grid-template-columns: minmax(0, 1fr); } }
            @media (max-width: 760px) { .adeo-marketability.marketability { padding: 10px; } .adeo-marketability > form, .adeo-marketability .marketability__log { padding: 12px; } .adeo-marketability .marketability__row { grid-template-columns: minmax(0, 1fr); gap: 8px; } .adeo-marketability-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } .adeo-marketability-result { padding: 12px; } }
        `;
        document.head.append(style);
    }

    function initMarketability() {
        const records = new Map();
        const bindings = new WeakMap();
        let sequence = 0, frame = null, timer = null;
        const active = record => ['downloading', 'loading', 'reading', 'calculating'].includes(record.phase);
        const element = (tag, className, text = '') => { const node = document.createElement(tag); node.className = className; node.textContent = text; return node; };
        function stop(record, message) {
            record.token++;
            record.controller?.abort(); record.controller = null;
            record.worker?.terminate(); record.worker = null;
            clearTimeout(record.timeout); record.timeout = null;
            if (message) { record.phase = 'error'; record.message = message; record.percent = null; record.finished = Date.now(); }
        }
        function updateTime(record) {
            if (record.time) record.time.textContent = record.started ? `Время анализа: ${Math.floor(((record.finished ?? Date.now()) - record.started) / 1000)} с` : '';
        }
        function render(record) {
            if (!record.panel) return;
            record.detail.hidden = !record.expanded;
            record.panel.dataset.phase = record.phase;
            record.status.textContent = record.message;
            record.progress.hidden = !active(record);
            if (record.percent === null) record.progress.removeAttribute('value');
            else record.progress.value = record.percent;
            record.retry.hidden = active(record);
            record.cancel.hidden = !active(record);
            record.metrics.hidden = !record.result;
            if (record.rendered !== record.result) {
                record.rendered = record.result;
                renderMarketabilitySummary(record.metrics, record.notes, record.result);
            }
            updateTime(record);
        }
        function mount(record, row) {
            if (!record.detail) {
                const detail = element('tr', 'adeo-marketability-detail q-virtual-scroll--with-prev');
                const cell = element('td', ''); const panel = element('section', 'adeo-marketability-result');
                panel.id = `adeo-marketability-result-${++sequence}`; panel.setAttribute('aria-label', 'Анализ конкурентоспособности отчёта');
                const heading = element('div', 'adeo-marketability-heading');
                record.time = element('span', 'adeo-marketability-time'); heading.append(element('h3', '', 'Анализ отчёта'), record.time);
                record.caption = element('div', 'adeo-marketability-caption');
                record.status = element('div', 'adeo-marketability-status'); record.status.setAttribute('role', 'status');
                record.progress = element('progress', 'adeo-marketability-progress'); record.progress.max = 100; record.progress.setAttribute('aria-label', 'Прогресс текущего этапа анализа');
                record.metrics = element('div', 'adeo-marketability-metrics'); record.notes = element('div', '');
                const controls = element('div', 'adeo-marketability-controls');
                record.retry = createButton('Повторить анализ', () => void start(record), 'adeo-marketability-button');
                record.cancel = createButton('Остановить анализ', () => { stop(record, 'Анализ остановлен. Исходный отчёт доступен для скачивания.'); render(record); schedule(); }, 'adeo-marketability-button');
                const close = createButton('Свернуть', () => { record.expanded = false; render(record); schedule(); refreshScroll(row); }, 'adeo-marketability-button');
                controls.append(record.retry, record.cancel, close);
                panel.append(heading, record.caption, record.status, record.progress, record.metrics, record.notes, controls);
                cell.append(panel); detail.append(cell); record.detail = detail; record.panel = panel;
            }
            record.detail.firstElementChild.colSpan = row.children.length;
            record.caption.textContent = record.label;
            if (row.nextElementSibling !== record.detail) row.after(record.detail);
            render(record);
        }
        function refreshScroll(row) {
            // Дополнительная строка учитывается виртуальной таблицей вместе с исходной записью.
            requestAnimationFrame(() => row.closest('.q-table__middle')?.dispatchEvent(new Event('scroll')));
        }
        async function start(record) {
            if (active(record) || Array.from(records.values()).some(other => other !== record && active(other))) return;
            stop(record);
            const token = record.token;
            Object.assign(record, { phase: 'downloading', message: 'Получение исходного Excel…', percent: null, result: null,
                expanded: true, started: Date.now(), finished: null });
            const current = () => token === record.token;
            const fail = message => { if (current()) { stop(record, message); render(record); schedule(); } };
            render(record); schedule();
            try {
                let buffer;
                if (record.blob) buffer = await record.blob.arrayBuffer();
                else {
                    record.controller = new AbortController();
                    record.timeout = setTimeout(() => fail('Сервер слишком долго передаёт отчёт. Обновите очередь и повторите анализ.'), 90000);
                    const url = new URL(record.href);
                    const response = await fetch(url.href, { credentials: url.origin === window.location.origin ? 'same-origin' : 'omit', cache: 'no-store', signal: record.controller.signal });
                    if (!current()) return;
                    if (!response.ok) throw new Error([401, 403, 404].includes(response.status) ? 'Ссылка на отчёт недоступна или срок её действия истёк. Обновите очередь штатной кнопкой и нажмите «Анализ» снова.' : `Не удалось получить отчёт: HTTP ${response.status}.`);
                    const limit = 50 * 1024 * 1024, total = Number(response.headers.get('content-length'));
                    if (total > limit) throw new Error('Отчёт больше 50 МБ. Используйте скачивание исходного файла.');
                    const reader = response.body.getReader(), chunks = []; let length = 0, lastUpdate = 0;
                    while (true) {
                        const { value, done } = await reader.read();
                        if (!current()) { await reader.cancel(); return; }
                        if (done) break;
                        length += value.byteLength;
                        if (length > limit) { await reader.cancel(); throw new Error('Отчёт больше 50 МБ. Используйте скачивание исходного файла.'); }
                        chunks.push(value);
                        if (Date.now() - lastUpdate > 150) {
                            lastUpdate = Date.now(); record.percent = total > 0 ? Math.min(100, length / total * 100) : null;
                            record.message = `Получение исходного Excel… ${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(length / 1048576)} МБ`; render(record);
                        }
                    }
                    const bytes = new Uint8Array(length); let offset = 0;
                    chunks.forEach(chunk => { bytes.set(chunk, offset); offset += chunk.length; });
                    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('Сервер вернул не Excel-файл. Обновите очередь отчётов и повторите анализ.');
                    buffer = bytes.buffer; record.blob = new Blob([buffer]);
                    // Храним не более двух последних исходников; раскрытые результаты сохраняются отдельно.
                    const cached = Array.from(records.values()).filter(other => other !== record && other.blob).sort((a, b) => b.started - a.started);
                    cached.slice(1).forEach(other => { other.blob = null; });
                }
                if (!current()) return;
                clearTimeout(record.timeout); record.controller = null;
                record.phase = 'loading'; record.percent = null; record.message = 'Подготовка анализа…'; render(record);
                const source = URL.createObjectURL(new Blob([getRelevanceWorkerSources(), '\n;\n',
                    `(${relevanceAnalysisWorker.toString()})(${calculateMarketabilityWorkbook.toString()});`], { type: 'application/javascript' }));
                try { record.worker = new Worker(source); }
                catch { throw new Error('Браузер не разрешил фоновый анализ. Исходный файл можно скачать штатной кнопкой.'); }
                finally { URL.revokeObjectURL(source); }
                record.worker.onerror = event => { event.preventDefault(); fail('Не удалось запустить анализ. Обновите страницу и повторите попытку.'); };
                record.worker.onmessage = event => {
                    if (!current()) return;
                    Object.assign(record, event.data, { percent: event.data.percent ?? null });
                    if (['done', 'error'].includes(record.phase)) {
                        record.finished = Date.now(); clearTimeout(record.timeout); record.timeout = null;
                        record.worker.terminate(); record.worker = null; schedule(); refreshScroll(record.row);
                        const button = bindings.get(record.row)?.button;
                        if (record.expanded && (document.activeElement === button || record.panel.contains(document.activeElement))) {
                            requestAnimationFrame(() => record.panel.scrollIntoView({ block: 'nearest' }));
                        }
                    }
                    render(record);
                };
                record.timeout = setTimeout(() => fail('Анализ остановлен: превышено время ожидания 5 минут. Можно повторить анализ или скачать исходный отчёт.'), 300000);
                record.worker.postMessage({ buffer }, [buffer]);
            } catch (error) { fail(error.name === 'TypeError' ? 'Не удалось прочитать отчёт из хранилища. Проверьте соединение, обновите очередь и повторите анализ.' : error.message || 'Не удалось выполнить анализ.'); }
        }
        function clear() {
            records.forEach(record => { stop(record); record.detail?.remove(); record.blob = null; }); records.clear();
        }
        function update() {
            frame = null;
            if (!/^\/reports\/marketability\/?$/.test(window.location.pathname)) { clear(); return; }
            const root = document.querySelector('.marketability'); if (!root) return;
            root.classList.add('adeo-marketability'); installMarketabilityStyles();
            const busy = Array.from(records.values()).some(active);
            const visible = new Set();
            root.querySelectorAll('.marketability__log table.q-table > tbody > tr:not(.adeo-marketability-detail)').forEach(row => {
                if (row.children.length < 4 || row.closest('tbody')?.getAttribute('aria-hidden') === 'true') return;
                const cell = row.lastElementChild; cell.classList.add('adeo-marketability-report');
                const link = cell.querySelector('a[download][href]');
                let key = null;
                try { const url = new URL(link?.getAttribute('href'), window.location.href); if (link && url.protocol === 'https:') key = url.origin + url.pathname; } catch { /* У задания без готовой ссылки анализ пока недоступен. */ }
                let binding = bindings.get(row);
                if (!binding || !cell.contains(binding.button)) {
                    cell.querySelectorAll('.adeo-marketability-launch').forEach(button => button.remove());
                    const button = createButton('Анализ', () => {
                        const bound = bindings.get(row), record = records.get(bound?.key); if (!record) return;
                        record.expanded = !record.expanded;
                        mount(record, row); refreshScroll(row);
                        if (record.phase === 'idle') { record.expanded = true; void start(record); }
                        if (record.expanded) requestAnimationFrame(() => record.panel.scrollIntoView({ block: 'nearest' }));
                        schedule();
                    }, 'adeo-marketability-button adeo-marketability-launch');
                    binding = { key: null, button }; bindings.set(row, binding); cell.append(button);
                }
                if (binding.key && binding.key !== key) records.get(binding.key)?.detail?.remove();
                binding.key = key;
                if (!key) { binding.button.disabled = true; if (binding.button.textContent !== 'Анализ') binding.button.textContent = 'Анализ'; binding.button.title = 'Анализ доступен после готовности отчёта'; binding.button.removeAttribute('aria-controls'); binding.button.setAttribute('aria-expanded', 'false'); return; }
                let record = records.get(key);
                if (!record) {
                    record = { key, token: 0, phase: 'idle', percent: null, message: '', result: null, expanded: false, started: null, finished: null, blob: null };
                    records.set(key, record);
                }
                visible.add(record); record.href = link.href; record.row = row;
                record.label = [row.children[1].textContent.trim(), row.children[2].textContent.trim()].filter(Boolean).join(' · ');
                if (record.detail) mount(record, row);
                const text = record.phase === 'idle' ? 'Анализ' : record.expanded ? 'Свернуть' : 'Результат';
                if (binding.button.textContent !== text) binding.button.textContent = text;
                binding.button.disabled = busy && record.phase === 'idle';
                binding.button.title = busy && record.phase === 'idle' ? 'Дождитесь завершения текущего анализа' : 'Показать анализ этого отчёта';
                binding.button.setAttribute('aria-expanded', String(record.expanded));
                if (record.panel) binding.button.setAttribute('aria-controls', record.panel.id);
                if (record.retry) record.retry.disabled = busy && !active(record);
            });
            records.forEach(record => { if (!visible.has(record)) record.detail?.remove(); });
        }
        function schedule() { if (frame === null) frame = requestAnimationFrame(update); }
        const observer = new MutationObserver(mutations => {
            if (mutations.every(mutation => {
                const node = mutation.target.nodeType === 3 ? mutation.target.parentElement : mutation.target;
                return node?.closest?.('.adeo-marketability-result');
            })) return;
            schedule();
        });
        const config = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href'] };
        observer.observe(document.body, config); update();
        timer = setInterval(() => records.forEach(updateTime), 1000);
        window.addEventListener('pagehide', () => {
            observer.disconnect(); clearInterval(timer); if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
            records.forEach(record => { if (active(record)) { stop(record, 'Анализ прерван при уходе со страницы. Его можно запустить повторно.'); render(record); } });
        });
        window.addEventListener('pageshow', event => { if (event.persisted) { observer.observe(document.body, config); timer = setInterval(() => records.forEach(updateTime), 1000); update(); } });
    }

    function initSupplierCalendar() {
        function update() {
            if (!/^\/supplier\/supplier-list\/?$/.test(window.location.pathname)) return;
            document.querySelectorAll('.work-calendar').forEach(calendar => {
                const toolbar = calendar.querySelector('.row'); if (!toolbar) return;
                installScheduleStyles();
                if (!calendar.querySelector('.adeo-schedule-launch')) {
                    const button = scheduleElement('button', 'Мастер расписания', 'adeo-schedule-launch'); button.type = 'button';
                    button.addEventListener('click', () => openScheduleWizard(calendar, button).catch(error => alert(error.message)));
                    toolbar.append(button);
                }
                if (!calendar.querySelector('.adeo-schedule-clear')) {
                    const button = scheduleElement('button', 'Очистить всё расписание', 'adeo-schedule-clear'); button.type = 'button';
                    button.addEventListener('click', () => openScheduleWizard(calendar, button, 'clear').catch(error => alert(error.message)));
                    toolbar.append(button);
                }
            });
        }
        const observer = new MutationObserver(mutations => {
            if (mutations.every(mutation => {
                const element = mutation.target.nodeType === 3 ? mutation.target.parentElement : mutation.target;
                return element?.closest?.('.adeo-schedule-overlay');
            })) return;
            update();
        });
        observer.observe(document.body, { childList: true, subtree: true }); update();
        window.addEventListener('pagehide', () => observer.disconnect());
        window.addEventListener('pageshow', event => { if (event.persisted) { observer.observe(document.body, { childList: true, subtree: true }); update(); } });
    }

    function init() {
        const path = window.location.pathname;
        if (/^\/admin\/admin_pricerelevance\/list\/?$/.test(path)) initPriceRelevance();
        else if (path.startsWith('/admin/supplier/price/compare/')) initCompare();
        else if (path.startsWith('/admin/supplier/price/comparemode/')) initCompareMode();
        else if (window.location.hostname === 'avatar.adeo.pro' && path === '/istat.php') initImportStatistics();
        else if (window.location.hostname === 'crm.adeo.pro') { initSupplierCalendar(); initMarketability(); }
    }

    const autoPriceCheckPage = typeof window !== 'undefined' && window.location?.search &&
        /^\/admin\/admin_pricerelevance\/list\/?$/.test(window.location.pathname) &&
        new URLSearchParams(window.location.search).get(AUTO_PRICE_CHECK_PARAM) === '1';
    if (!autoPriceCheckPage) {
        installLoadingProgress();
        installQuickLinksMenu();
    }
    installRelevanceProgress();
    if (autoPriceCheckPage) {
        openAutoPriceCheckPage();
        return;
    }
    prepareInitialCompareRequest();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else {
        init();
    }
    // НАЧАЛО ВСТРОЕННЫХ БИБЛИОТЕК АНАЛИЗА
    // Создано scripts/bundle-analysis.cjs. Версии и лицензии находятся в assets/vendor.
    function getRelevanceWorkerSources() {
        return "/*\n                                 Apache License\n                           Version 2.0, January 2004\n                        http://www.apache.org/licenses/\n\n   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION\n\n   1. Definitions.\n\n      \"License\" shall mean the terms and conditions for use, reproduction,\n      and distribution as defined by Sections 1 through 9 of this document.\n\n      \"Licensor\" shall mean the copyright owner or entity authorized by\n      the copyright owner that is granting the License.\n\n      \"Legal Entity\" shall mean the union of the acting entity and all\n      other entities that control, are controlled by, or are under common\n      control with that entity. For the purposes of this definition,\n      \"control\" means (i) the power, direct or indirect, to cause the\n      direction or management of such entity, whether by contract or\n      otherwise, or (ii) ownership of fifty percent (50%) or more of the\n      outstanding shares, or (iii) beneficial ownership of such entity.\n\n      \"You\" (or \"Your\") shall mean an individual or Legal Entity\n      exercising permissions granted by this License.\n\n      \"Source\" form shall mean the preferred form for making modifications,\n      including but not limited to software source code, documentation\n      source, and configuration files.\n\n      \"Object\" form shall mean any form resulting from mechanical\n      transformation or translation of a Source form, including but\n      not limited to compiled object code, generated documentation,\n      and conversions to other media types.\n\n      \"Work\" shall mean the work of authorship, whether in Source or\n      Object form, made available under the License, as indicated by a\n      copyright notice that is included in or attached to the work\n      (an example is provided in the Appendix below).\n\n      \"Derivative Works\" shall mean any work, whether in Source or Object\n      form, that is based on (or derived from) the Work and for which the\n      editorial revisions, annotations, elaborations, or other modifications\n      represent, as a whole, an original work of authorship. For the purposes\n      of this License, Derivative Works shall not include works that remain\n      separable from, or merely link (or bind by name) to the interfaces of,\n      the Work and Derivative Works thereof.\n\n      \"Contribution\" shall mean any work of authorship, including\n      the original version of the Work and any modifications or additions\n      to that Work or Derivative Works thereof, that is intentionally\n      submitted to Licensor for inclusion in the Work by the copyright owner\n      or by an individual or Legal Entity authorized to submit on behalf of\n      the copyright owner. For the purposes of this definition, \"submitted\"\n      means any form of electronic, verbal, or written communication sent\n      to the Licensor or its representatives, including but not limited to\n      communication on electronic mailing lists, source code control systems,\n      and issue tracking systems that are managed by, or on behalf of, the\n      Licensor for the purpose of discussing and improving the Work, but\n      excluding communication that is conspicuously marked or otherwise\n      designated in writing by the copyright owner as \"Not a Contribution.\"\n\n      \"Contributor\" shall mean Licensor and any individual or Legal Entity\n      on behalf of whom a Contribution has been received by Licensor and\n      subsequently incorporated within the Work.\n\n   2. Grant of Copyright License. Subject to the terms and conditions of\n      this License, each Contributor hereby grants to You a perpetual,\n      worldwide, non-exclusive, no-charge, royalty-free, irrevocable\n      copyright license to reproduce, prepare Derivative Works of,\n      publicly display, publicly perform, sublicense, and distribute the\n      Work and such Derivative Works in Source or Object form.\n\n   3. Grant of Patent License. Subject to the terms and conditions of\n      this License, each Contributor hereby grants to You a perpetual,\n      worldwide, non-exclusive, no-charge, royalty-free, irrevocable\n      (except as stated in this section) patent license to make, have made,\n      use, offer to sell, sell, import, and otherwise transfer the Work,\n      where such license applies only to those patent claims licensable\n      by such Contributor that are necessarily infringed by their\n      Contribution(s) alone or by combination of their Contribution(s)\n      with the Work to which such Contribution(s) was submitted. If You\n      institute patent litigation against any entity (including a\n      cross-claim or counterclaim in a lawsuit) alleging that the Work\n      or a Contribution incorporated within the Work constitutes direct\n      or contributory patent infringement, then any patent licenses\n      granted to You under this License for that Work shall terminate\n      as of the date such litigation is filed.\n\n   4. Redistribution. You may reproduce and distribute copies of the\n      Work or Derivative Works thereof in any medium, with or without\n      modifications, and in Source or Object form, provided that You\n      meet the following conditions:\n\n      (a) You must give any other recipients of the Work or\n          Derivative Works a copy of this License; and\n\n      (b) You must cause any modified files to carry prominent notices\n          stating that You changed the files; and\n\n      (c) You must retain, in the Source form of any Derivative Works\n          that You distribute, all copyright, patent, trademark, and\n          attribution notices from the Source form of the Work,\n          excluding those notices that do not pertain to any part of\n          the Derivative Works; and\n\n      (d) If the Work includes a \"NOTICE\" text file as part of its\n          distribution, then any Derivative Works that You distribute must\n          include a readable copy of the attribution notices contained\n          within such NOTICE file, excluding those notices that do not\n          pertain to any part of the Derivative Works, in at least one\n          of the following places: within a NOTICE text file distributed\n          as part of the Derivative Works; within the Source form or\n          documentation, if provided along with the Derivative Works; or,\n          within a display generated by the Derivative Works, if and\n          wherever such third-party notices normally appear. The contents\n          of the NOTICE file are for informational purposes only and\n          do not modify the License. You may add Your own attribution\n          notices within Derivative Works that You distribute, alongside\n          or as an addendum to the NOTICE text from the Work, provided\n          that such additional attribution notices cannot be construed\n          as modifying the License.\n\n      You may add Your own copyright statement to Your modifications and\n      may provide additional or different license terms and conditions\n      for use, reproduction, or distribution of Your modifications, or\n      for any such Derivative Works as a whole, provided Your use,\n      reproduction, and distribution of the Work otherwise complies with\n      the conditions stated in this License.\n\n   5. Submission of Contributions. Unless You explicitly state otherwise,\n      any Contribution intentionally submitted for inclusion in the Work\n      by You to the Licensor shall be under the terms and conditions of\n      this License, without any additional terms or conditions.\n      Notwithstanding the above, nothing herein shall supersede or modify\n      the terms of any separate license agreement you may have executed\n      with Licensor regarding such Contributions.\n\n   6. Trademarks. This License does not grant permission to use the trade\n      names, trademarks, service marks, or product names of the Licensor,\n      except as required for reasonable and customary use in describing the\n      origin of the Work and reproducing the content of the NOTICE file.\n\n   7. Disclaimer of Warranty. Unless required by applicable law or\n      agreed to in writing, Licensor provides the Work (and each\n      Contributor provides its Contributions) on an \"AS IS\" BASIS,\n      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or\n      implied, including, without limitation, any warranties or conditions\n      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A\n      PARTICULAR PURPOSE. You are solely responsible for determining the\n      appropriateness of using or redistributing the Work and assume any\n      risks associated with Your exercise of permissions under this License.\n\n   8. Limitation of Liability. In no event and under no legal theory,\n      whether in tort (including negligence), contract, or otherwise,\n      unless required by applicable law (such as deliberate and grossly\n      negligent acts) or agreed to in writing, shall any Contributor be\n      liable to You for damages, including any direct, indirect, special,\n      incidental, or consequential damages of any character arising as a\n      result of this License or out of the use or inability to use the\n      Work (including but not limited to damages for loss of goodwill,\n      work stoppage, computer failure or malfunction, or any and all\n      other commercial damages or losses), even if such Contributor\n      has been advised of the possibility of such damages.\n\n   9. Accepting Warranty or Additional Liability. While redistributing\n      the Work or Derivative Works thereof, You may choose to offer,\n      and charge a fee for, acceptance of support, warranty, indemnity,\n      or other liability obligations and/or rights consistent with this\n      License. However, in accepting such obligations, You may act only\n      on Your own behalf and on Your sole responsibility, not on behalf\n      of any other Contributor, and only if You agree to indemnify,\n      defend, and hold each Contributor harmless for any liability\n      incurred by, or claims asserted against, such Contributor by reason\n      of your accepting any such warranty or additional liability.\n\n   END OF TERMS AND CONDITIONS\n\n   APPENDIX: How to apply the Apache License to your work.\n\n      To apply the Apache License to your work, attach the following\n      boilerplate notice, with the fields enclosed by brackets \"{}\"\n      replaced with your own identifying information. (Don't include\n      the brackets!)  The text should be enclosed in the appropriate\n      comment syntax for the file format. We also recommend that a\n      file or class name and description of purpose be included on the\n      same \"printed page\" as the copyright notice for easier\n      identification within third-party archives.\n\n   Copyright (C) 2012-present   SheetJS LLC\n\n   Licensed under the Apache License, Version 2.0 (the \"License\");\n   you may not use this file except in compliance with the License.\n   You may obtain a copy of the License at\n\n       http://www.apache.org/licenses/LICENSE-2.0\n\n   Unless required by applicable law or agreed to in writing, software\n   distributed under the License is distributed on an \"AS IS\" BASIS,\n   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.\n   See the License for the specific language governing permissions and\n   limitations under the License.\n\n*/\n/*! xlsx.js (C) 2013-present SheetJS -- http://sheetjs.com */\nvar XLSX={};function make_xlsx_lib(e){e.version=\"0.20.3\";var r=1200,t=1252;var a;var n=[874,932,936,949,950,1250,1251,1252,1253,1254,1255,1256,1257,1258,1e4];var i={0:1252,1:65001,2:65001,77:1e4,128:932,129:949,130:1361,134:936,136:950,161:1253,162:1254,163:1258,177:1255,178:1256,186:1257,204:1251,222:874,238:1250,255:1252,69:6969};var s=function(e){if(n.indexOf(e)==-1)return;t=i[0]=e};function l(){s(1252)}var o=function(e){r=e;s(e)};function c(){o(1200);l()}function f(e){var r=[];for(var t=0,a=e.length;t<a;++t)r[t]=e.charCodeAt(t);return r}function u(e){var r=[];for(var t=0;t<e.length>>1;++t)r[t]=String.fromCharCode(e.charCodeAt(2*t)+(e.charCodeAt(2*t+1)<<8));return r.join(\"\")}function h(e){var r=[];for(var t=0;t<e.length>>1;++t)r[t]=String.fromCharCode(e[2*t]+(e[2*t+1]<<8));return r.join(\"\")}function d(e){var r=[];for(var t=0;t<e.length>>1;++t)r[t]=String.fromCharCode(e.charCodeAt(2*t+1)+(e.charCodeAt(2*t)<<8));return r.join(\"\")}var p=function(e){var r=e.charCodeAt(0),t=e.charCodeAt(1);if(r==255&&t==254)return u(e.slice(2));if(r==254&&t==255)return d(e.slice(2));if(r==65279)return e.slice(1);return e};var m=function Dc(e){return String.fromCharCode(e)};var v=function Oc(e){return String.fromCharCode(e)};function g(e){a=e;o=function(e){r=e;s(e)};p=function(e){if(e.charCodeAt(0)===255&&e.charCodeAt(1)===254){return a.utils.decode(1200,f(e.slice(2)))}return e};m=function n(e){if(r===1200)return String.fromCharCode(e);return a.utils.decode(r,[e&255,e>>8])[0]};v=function i(e){return a.utils.decode(t,[e])[0]};va()}var b=null;var w=true;var k=\"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\";function y(e){var r=\"\";var t=0,a=0,n=0,i=0,s=0,l=0,o=0;for(var c=0;c<e.length;){t=e.charCodeAt(c++);i=t>>2;a=e.charCodeAt(c++);s=(t&3)<<4|a>>4;n=e.charCodeAt(c++);l=(a&15)<<2|n>>6;o=n&63;if(isNaN(a)){l=o=64}else if(isNaN(n)){o=64}r+=k.charAt(i)+k.charAt(s)+k.charAt(l)+k.charAt(o)}return r}function x(e){var r=\"\";var t=0,a=0,n=0,i=0,s=0,l=0,o=0;for(var c=0;c<e.length;){t=e.charCodeAt(c++);if(t>255)t=95;i=t>>2;a=e.charCodeAt(c++);if(a>255)a=95;s=(t&3)<<4|a>>4;n=e.charCodeAt(c++);if(n>255)n=95;l=(a&15)<<2|n>>6;o=n&63;if(isNaN(a)){l=o=64}else if(isNaN(n)){o=64}r+=k.charAt(i)+k.charAt(s)+k.charAt(l)+k.charAt(o)}return r}function C(e){var r=\"\";var t=0,a=0,n=0,i=0,s=0,l=0,o=0;for(var c=0;c<e.length;){t=e[c++];i=t>>2;a=e[c++];s=(t&3)<<4|a>>4;n=e[c++];l=(a&15)<<2|n>>6;o=n&63;if(isNaN(a)){l=o=64}else if(isNaN(n)){o=64}r+=k.charAt(i)+k.charAt(s)+k.charAt(l)+k.charAt(o)}return r}function S(e){var r=\"\";var t=0,a=0,n=0,i=0,s=0,l=0,o=0;if(e.slice(0,5)==\"data:\"){var c=e.slice(0,1024).indexOf(\";base64,\");if(c>-1)e=e.slice(c+8)}e=e.replace(/[^\\w\\+\\/\\=]/g,\"\");for(var c=0;c<e.length;){i=k.indexOf(e.charAt(c++));s=k.indexOf(e.charAt(c++));t=i<<2|s>>4;r+=String.fromCharCode(t);l=k.indexOf(e.charAt(c++));a=(s&15)<<4|l>>2;if(l!==64){r+=String.fromCharCode(a)}o=k.indexOf(e.charAt(c++));n=(l&3)<<6|o;if(o!==64){r+=String.fromCharCode(n)}}return r}var _=function(){return typeof Buffer!==\"undefined\"&&typeof undefined!==\"undefined\"&&typeof{}!==\"undefined\"&&!!{}.node}();var A=function(){if(typeof Buffer!==\"undefined\"){var e=!Buffer.from;if(!e)try{Buffer.from(\"foo\",\"utf8\")}catch(r){e=true}return e?function(e,r){return r?new Buffer(e,r):new Buffer(e)}:Buffer.from.bind(Buffer)}return function(){}}();var T=function(){if(typeof Buffer===\"undefined\")return false;var e=A([65,0]);if(!e)return false;var r=e.toString(\"utf16le\");return r.length==1}();function E(e){if(_)return Buffer.alloc?Buffer.alloc(e):new Buffer(e);return typeof Uint8Array!=\"undefined\"?new Uint8Array(e):new Array(e)}function F(e){if(_)return Buffer.allocUnsafe?Buffer.allocUnsafe(e):new Buffer(e);return typeof Uint8Array!=\"undefined\"?new Uint8Array(e):new Array(e)}var D=function Nc(e){if(_)return A(e,\"binary\");return e.split(\"\").map(function(e){return e.charCodeAt(0)&255})};function O(e){if(typeof ArrayBuffer===\"undefined\")return D(e);var r=new ArrayBuffer(e.length),t=new Uint8Array(r);for(var a=0;a!=e.length;++a)t[a]=e.charCodeAt(a)&255;return r}function N(e){if(Array.isArray(e))return e.map(function(e){return String.fromCharCode(e)}).join(\"\");var r=[];for(var t=0;t<e.length;++t)r[t]=String.fromCharCode(e[t]);return r.join(\"\")}function M(e){if(typeof Uint8Array===\"undefined\")throw new Error(\"Unsupported\");return new Uint8Array(e)}function I(e){if(typeof ArrayBuffer==\"undefined\")throw new Error(\"Unsupported\");if(e instanceof ArrayBuffer)return I(new Uint8Array(e));var r=new Array(e.length);for(var t=0;t<e.length;++t)r[t]=e[t];return r}var P=_?function(e){return Buffer.concat(e.map(function(e){return Buffer.isBuffer(e)?e:A(e)}))}:function(e){if(typeof Uint8Array!==\"undefined\"){var r=0,t=0;for(r=0;r<e.length;++r)t+=e[r].length;var a=new Uint8Array(t);var n=0;for(r=0,t=0;r<e.length;t+=n,++r){n=e[r].length;if(e[r]instanceof Uint8Array)a.set(e[r],t);else if(typeof e[r]==\"string\")a.set(new Uint8Array(D(e[r])),t);else a.set(new Uint8Array(e[r]),t)}return a}return[].concat.apply([],e.map(function(e){return Array.isArray(e)?e:[].slice.call(e)}))};function R(e){var r=[],t=0,a=e.length+250;var n=E(e.length+255);for(var i=0;i<e.length;++i){var s=e.charCodeAt(i);if(s<128)n[t++]=s;else if(s<2048){n[t++]=192|s>>6&31;n[t++]=128|s&63}else if(s>=55296&&s<57344){s=(s&1023)+64;var l=e.charCodeAt(++i)&1023;n[t++]=240|s>>8&7;n[t++]=128|s>>2&63;n[t++]=128|l>>6&15|(s&3)<<4;n[t++]=128|l&63}else{n[t++]=224|s>>12&15;n[t++]=128|s>>6&63;n[t++]=128|s&63}if(t>a){r.push(n.slice(0,t));t=0;n=E(65535);a=65530}}r.push(n.slice(0,t));return P(r)}var L=/\\u0000/g,U=/[\\u0001-\\u0006]/g;function B(e){var r=\"\",t=e.length-1;while(t>=0)r+=e.charAt(t--);return r}function z(e,r){var t=\"\"+e;return t.length>=r?t:xr(\"0\",r-t.length)+t}function W(e,r){var t=\"\"+e;return t.length>=r?t:xr(\" \",r-t.length)+t}function j(e,r){var t=\"\"+e;return t.length>=r?t:t+xr(\" \",r-t.length)}function H(e,r){var t=\"\"+Math.round(e);return t.length>=r?t:xr(\"0\",r-t.length)+t}function V(e,r){var t=\"\"+e;return t.length>=r?t:xr(\"0\",r-t.length)+t}var X=Math.pow(2,32);function G(e,r){if(e>X||e<-X)return H(e,r);var t=Math.round(e);return V(t,r)}function Y(e,r){r=r||0;return e.length>=7+r&&(e.charCodeAt(r)|32)===103&&(e.charCodeAt(r+1)|32)===101&&(e.charCodeAt(r+2)|32)===110&&(e.charCodeAt(r+3)|32)===101&&(e.charCodeAt(r+4)|32)===114&&(e.charCodeAt(r+5)|32)===97&&(e.charCodeAt(r+6)|32)===108}var J=[[\"Sun\",\"Sunday\"],[\"Mon\",\"Monday\"],[\"Tue\",\"Tuesday\"],[\"Wed\",\"Wednesday\"],[\"Thu\",\"Thursday\"],[\"Fri\",\"Friday\"],[\"Sat\",\"Saturday\"]];var Z=[[\"J\",\"Jan\",\"January\"],[\"F\",\"Feb\",\"February\"],[\"M\",\"Mar\",\"March\"],[\"A\",\"Apr\",\"April\"],[\"M\",\"May\",\"May\"],[\"J\",\"Jun\",\"June\"],[\"J\",\"Jul\",\"July\"],[\"A\",\"Aug\",\"August\"],[\"S\",\"Sep\",\"September\"],[\"O\",\"Oct\",\"October\"],[\"N\",\"Nov\",\"November\"],[\"D\",\"Dec\",\"December\"]];function K(e){if(!e)e={};e[0]=\"General\";e[1]=\"0\";e[2]=\"0.00\";e[3]=\"#,##0\";e[4]=\"#,##0.00\";e[9]=\"0%\";e[10]=\"0.00%\";e[11]=\"0.00E+00\";e[12]=\"# ?/?\";e[13]=\"# ??/??\";e[14]=\"m/d/yy\";e[15]=\"d-mmm-yy\";e[16]=\"d-mmm\";e[17]=\"mmm-yy\";e[18]=\"h:mm AM/PM\";e[19]=\"h:mm:ss AM/PM\";e[20]=\"h:mm\";e[21]=\"h:mm:ss\";e[22]=\"m/d/yy h:mm\";e[37]=\"#,##0 ;(#,##0)\";e[38]=\"#,##0 ;[Red](#,##0)\";e[39]=\"#,##0.00;(#,##0.00)\";e[40]=\"#,##0.00;[Red](#,##0.00)\";e[45]=\"mm:ss\";e[46]=\"[h]:mm:ss\";e[47]=\"mmss.0\";e[48]=\"##0.0E+0\";e[49]=\"@\";e[56]='\"上午/下午 \"hh\"時\"mm\"分\"ss\"秒 \"';return e}var q={0:\"General\",1:\"0\",2:\"0.00\",3:\"#,##0\",4:\"#,##0.00\",9:\"0%\",10:\"0.00%\",11:\"0.00E+00\",12:\"# ?/?\",13:\"# ??/??\",14:\"m/d/yy\",15:\"d-mmm-yy\",16:\"d-mmm\",17:\"mmm-yy\",18:\"h:mm AM/PM\",19:\"h:mm:ss AM/PM\",20:\"h:mm\",21:\"h:mm:ss\",22:\"m/d/yy h:mm\",37:\"#,##0 ;(#,##0)\",38:\"#,##0 ;[Red](#,##0)\",39:\"#,##0.00;(#,##0.00)\",40:\"#,##0.00;[Red](#,##0.00)\",45:\"mm:ss\",46:\"[h]:mm:ss\",47:\"mmss.0\",48:\"##0.0E+0\",49:\"@\",56:'\"上午/下午 \"hh\"時\"mm\"分\"ss\"秒 \"'};var Q={5:37,6:38,7:39,8:40,23:0,24:0,25:0,26:0,27:14,28:14,29:14,30:14,31:14,50:14,51:14,52:14,53:14,54:14,55:14,56:14,57:14,58:14,59:1,60:2,61:3,62:4,67:9,68:10,69:12,70:13,71:14,72:14,73:15,74:16,75:17,76:20,77:21,78:22,79:45,80:46,81:47,82:0};var ee={5:'\"$\"#,##0_);\\\\(\"$\"#,##0\\\\)',63:'\"$\"#,##0_);\\\\(\"$\"#,##0\\\\)',6:'\"$\"#,##0_);[Red]\\\\(\"$\"#,##0\\\\)',64:'\"$\"#,##0_);[Red]\\\\(\"$\"#,##0\\\\)',7:'\"$\"#,##0.00_);\\\\(\"$\"#,##0.00\\\\)',65:'\"$\"#,##0.00_);\\\\(\"$\"#,##0.00\\\\)',8:'\"$\"#,##0.00_);[Red]\\\\(\"$\"#,##0.00\\\\)',66:'\"$\"#,##0.00_);[Red]\\\\(\"$\"#,##0.00\\\\)',41:'_(* #,##0_);_(* \\\\(#,##0\\\\);_(* \"-\"_);_(@_)',42:'_(\"$\"* #,##0_);_(\"$\"* \\\\(#,##0\\\\);_(\"$\"* \"-\"_);_(@_)',43:'_(* #,##0.00_);_(* \\\\(#,##0.00\\\\);_(* \"-\"??_);_(@_)',44:'_(\"$\"* #,##0.00_);_(\"$\"* \\\\(#,##0.00\\\\);_(\"$\"* \"-\"??_);_(@_)'};function re(e,r,t){var a=e<0?-1:1;var n=e*a;var i=0,s=1,l=0;var o=1,c=0,f=0;var u=Math.floor(n);while(c<r){u=Math.floor(n);l=u*s+i;f=u*c+o;if(n-u<5e-8)break;n=1/(n-u);i=s;s=l;o=c;c=f}if(f>r){if(c>r){f=o;l=i}else{f=c;l=s}}if(!t)return[0,a*l,f];var h=Math.floor(a*l/f);return[h,a*l-h*f,f]}function te(e){var r=e.toPrecision(16);if(r.indexOf(\"e\")>-1){var t=r.slice(0,r.indexOf(\"e\"));t=t.indexOf(\".\")>-1?t.slice(0,t.slice(0,2)==\"0.\"?17:16):t.slice(0,15)+xr(\"0\",t.length-15);return t+r.slice(r.indexOf(\"e\"))}var a=r.indexOf(\".\")>-1?r.slice(0,r.slice(0,2)==\"0.\"?17:16):r.slice(0,15)+xr(\"0\",r.length-15);return Number(a)}function ae(e,r,t){if(e>2958465||e<0)return null;e=te(e);var a=e|0,n=Math.floor(86400*(e-a)),i=0;var s=[];var l={D:a,T:n,u:86400*(e-a)-n,y:0,m:0,d:0,H:0,M:0,S:0,q:0};if(Math.abs(l.u)<1e-6)l.u=0;if(r&&r.date1904)a+=1462;if(l.u>.9999){l.u=0;if(++n==86400){l.T=n=0;++a;++l.D}}if(a===60){s=t?[1317,10,29]:[1900,2,29];i=3}else if(a===0){s=t?[1317,8,29]:[1900,1,0];i=6}else{if(a>60)--a;var o=new Date(1900,0,1);o.setDate(o.getDate()+a-1);s=[o.getFullYear(),o.getMonth()+1,o.getDate()];i=o.getDay();if(a<60)i=(i+6)%7;if(t)i=fe(o,s)}l.y=s[0];l.m=s[1];l.d=s[2];l.S=n%60;n=Math.floor(n/60);l.M=n%60;n=Math.floor(n/60);l.H=n;l.q=i;return l}function ne(e){return e.indexOf(\".\")==-1?e:e.replace(/(?:\\.0*|(\\.\\d*[1-9])0+)$/,\"$1\")}function ie(e){if(e.indexOf(\"E\")==-1)return e;return e.replace(/(?:\\.0*|(\\.\\d*[1-9])0+)[Ee]/,\"$1E\").replace(/(E[+-])(\\d)$/,\"$10$2\")}function se(e){var r=e<0?12:11;var t=ne(e.toFixed(12));if(t.length<=r)return t;t=e.toPrecision(10);if(t.length<=r)return t;return e.toExponential(5)}function le(e){var r=ne(e.toFixed(11));return r.length>(e<0?12:11)||r===\"0\"||r===\"-0\"?e.toPrecision(6):r}function oe(e){if(!isFinite(e))return isNaN(e)?\"#NUM!\":\"#DIV/0!\";var r=Math.floor(Math.log(Math.abs(e))*Math.LOG10E),t;if(r>=-4&&r<=-1)t=e.toPrecision(10+r);else if(Math.abs(r)<=9)t=se(e);else if(r===10)t=e.toFixed(10).substr(0,12);else t=le(e);return ne(ie(t.toUpperCase()))}function ce(e,r){switch(typeof e){case\"string\":return e;case\"boolean\":return e?\"TRUE\":\"FALSE\";case\"number\":return(e|0)===e?e.toString(10):oe(e);case\"undefined\":return\"\";case\"object\":if(e==null)return\"\";if(e instanceof Date)return $e(14,dr(e,r&&r.date1904),r);}throw new Error(\"unsupported value in General format: \"+e)}function fe(e,r){r[0]-=581;var t=e.getDay();if(e<60)t=(t+6)%7;return t}function ue(e,r,t,a){var n=\"\",i=0,s=0,l=t.y,o,c=0;switch(e){case 98:l=t.y+543;case 121:switch(r.length){case 1:;case 2:o=l%100;c=2;break;default:o=l%1e4;c=4;break;}break;case 109:switch(r.length){case 1:;case 2:o=t.m;c=r.length;break;case 3:return Z[t.m-1][1];case 5:return Z[t.m-1][0];default:return Z[t.m-1][2];}break;case 100:switch(r.length){case 1:;case 2:o=t.d;c=r.length;break;case 3:return J[t.q][0];default:return J[t.q][1];}break;case 104:switch(r.length){case 1:;case 2:o=1+(t.H+11)%12;c=r.length;break;default:throw\"bad hour format: \"+r;}break;case 72:switch(r.length){case 1:;case 2:o=t.H;c=r.length;break;default:throw\"bad hour format: \"+r;}break;case 77:switch(r.length){case 1:;case 2:o=t.M;c=r.length;break;default:throw\"bad minute format: \"+r;}break;case 115:if(r!=\"s\"&&r!=\"ss\"&&r!=\".0\"&&r!=\".00\"&&r!=\".000\")throw\"bad second format: \"+r;if(t.u===0&&(r==\"s\"||r==\"ss\"))return z(t.S,r.length);if(a>=2)s=a===3?1e3:100;else s=a===1?10:1;i=Math.round(s*(t.S+t.u));if(i>=60*s)i=0;if(r===\"s\")return i===0?\"0\":\"\"+i/s;n=z(i,2+a);if(r===\"ss\")return n.substr(0,2);return\".\"+n.substr(2,r.length-1);case 90:switch(r){case\"[h]\":;case\"[hh]\":o=t.D*24+t.H;break;case\"[m]\":;case\"[mm]\":o=(t.D*24+t.H)*60+t.M;break;case\"[s]\":;case\"[ss]\":o=((t.D*24+t.H)*60+t.M)*60+(a==0?Math.round(t.S+t.u):t.S);break;default:throw\"bad abstime format: \"+r;}c=r.length===3?1:2;break;case 101:o=l;c=1;break;}var f=c>0?z(o,c):\"\";return f}function he(e){var r=3;if(e.length<=r)return e;var t=e.length%r,a=e.substr(0,t);for(;t!=e.length;t+=r)a+=(a.length>0?\",\":\"\")+e.substr(t,r);return a}var de=/%/g;function pe(e,r,t){var a=r.replace(de,\"\"),n=r.length-a.length;return Me(e,a,t*Math.pow(10,2*n))+xr(\"%\",n)}function me(e,r,t){var a=r.length-1;while(r.charCodeAt(a-1)===44)--a;return Me(e,r.substr(0,a),t/Math.pow(10,3*(r.length-a)))}function ve(e,r){var t;var a=e.indexOf(\"E\")-e.indexOf(\".\")-1;if(e.match(/^#+0.0E\\+0$/)){if(r==0)return\"0.0E+0\";else if(r<0)return\"-\"+ve(e,-r);var n=e.indexOf(\".\");if(n===-1)n=e.indexOf(\"E\");var i=Math.floor(Math.log(r)*Math.LOG10E)%n;if(i<0)i+=n;t=(r/Math.pow(10,i)).toPrecision(a+1+(n+i)%n);if(t.indexOf(\"e\")===-1){var s=Math.floor(Math.log(r)*Math.LOG10E);if(t.indexOf(\".\")===-1)t=t.charAt(0)+\".\"+t.substr(1)+\"E+\"+(s-t.length+i);else t+=\"E+\"+(s-i);while(t.substr(0,2)===\"0.\"){t=t.charAt(0)+t.substr(2,n)+\".\"+t.substr(2+n);t=t.replace(/^0+([1-9])/,\"$1\").replace(/^0+\\./,\"0.\")}t=t.replace(/\\+-/,\"-\")}t=t.replace(/^([+-]?)(\\d*)\\.(\\d*)[Ee]/,function(e,r,t,a){return r+t+a.substr(0,(n+i)%n)+\".\"+a.substr(i)+\"E\"})}else t=r.toExponential(a);if(e.match(/E\\+00$/)&&t.match(/e[+-]\\d$/))t=t.substr(0,t.length-1)+\"0\"+t.charAt(t.length-1);if(e.match(/E\\-/)&&t.match(/e\\+/))t=t.replace(/e\\+/,\"e\");return t.replace(\"e\",\"E\")}var ge=/# (\\?+)( ?)\\/( ?)(\\d+)/;function be(e,r,t){var a=parseInt(e[4],10),n=Math.round(r*a),i=Math.floor(n/a);var s=n-i*a,l=a;return t+(i===0?\"\":\"\"+i)+\" \"+(s===0?xr(\" \",e[1].length+1+e[4].length):W(s,e[1].length)+e[2]+\"/\"+e[3]+z(l,e[4].length))}function we(e,r,t){return t+(r===0?\"\":\"\"+r)+xr(\" \",e[1].length+2+e[4].length)}var ke=/^#*0*\\.([0#]+)/;var ye=/\\)[^)]*[0#]/;var xe=/\\(###\\) ###\\\\?-####/;function Ce(e){var r=\"\",t;for(var a=0;a!=e.length;++a)switch(t=e.charCodeAt(a)){case 35:break;case 63:r+=\" \";break;case 48:r+=\"0\";break;default:r+=String.fromCharCode(t);}return r}function Se(e,r){var t=Math.pow(10,r);return\"\"+Math.round(e*t)/t}function _e(e,r){var t=e-Math.floor(e),a=Math.pow(10,r);if(r<(\"\"+Math.round(t*a)).length)return 0;return Math.round(t*a)}function Ae(e,r){if(r<(\"\"+Math.round((e-Math.floor(e))*Math.pow(10,r))).length){return 1}return 0}function Te(e){if(e<2147483647&&e>-2147483648)return\"\"+(e>=0?e|0:e-1|0);return\"\"+Math.floor(e)}function Ee(e,r,t){if(e.charCodeAt(0)===40&&!r.match(ye)){var a=r.replace(/\\( */,\"\").replace(/ \\)/,\"\").replace(/\\)/,\"\");if(t>=0)return Ee(\"n\",a,t);return\"(\"+Ee(\"n\",a,-t)+\")\"}if(r.charCodeAt(r.length-1)===44)return me(e,r,t);if(r.indexOf(\"%\")!==-1)return pe(e,r,t);if(r.indexOf(\"E\")!==-1)return ve(r,t);if(r.charCodeAt(0)===36)return\"$\"+Ee(e,r.substr(r.charAt(1)==\" \"?2:1),t);var n;var i,s,l,o=Math.abs(t),c=t<0?\"-\":\"\";if(r.match(/^00+$/))return c+G(o,r.length);if(r.match(/^[#?]+$/)){n=G(t,0);if(n===\"0\")n=\"\";return n.length>r.length?n:Ce(r.substr(0,r.length-n.length))+n}if(i=r.match(ge))return be(i,o,c);if(r.match(/^#+0+$/))return c+G(o,r.length-r.indexOf(\"0\"));if(i=r.match(ke)){n=Se(t,i[1].length).replace(/^([^\\.]+)$/,\"$1.\"+Ce(i[1])).replace(/\\.$/,\".\"+Ce(i[1])).replace(/\\.(\\d*)$/,function(e,r){return\".\"+r+xr(\"0\",Ce(i[1]).length-r.length)});return r.indexOf(\"0.\")!==-1?n:n.replace(/^0\\./,\".\")}r=r.replace(/^#+([0.])/,\"$1\");if(i=r.match(/^(0*)\\.(#*)$/)){return c+Se(o,i[2].length).replace(/\\.(\\d*[1-9])0*$/,\".$1\").replace(/^(-?\\d*)$/,\"$1.\").replace(/^0\\./,i[1].length?\"0.\":\".\")}if(i=r.match(/^#{1,3},##0(\\.?)$/))return c+he(G(o,0));if(i=r.match(/^#,##0\\.([#0]*0)$/)){return t<0?\"-\"+Ee(e,r,-t):he(\"\"+(Math.floor(t)+Ae(t,i[1].length)))+\".\"+z(_e(t,i[1].length),i[1].length)}if(i=r.match(/^#,#*,#0/))return Ee(e,r.replace(/^#,#*,/,\"\"),t);if(i=r.match(/^([0#]+)(\\\\?-([0#]+))+$/)){n=B(Ee(e,r.replace(/[\\\\-]/g,\"\"),t));s=0;return B(B(r.replace(/\\\\/g,\"\")).replace(/[0#]/g,function(e){return s<n.length?n.charAt(s++):e===\"0\"?\"0\":\"\"}))}if(r.match(xe)){n=Ee(e,\"##########\",t);return\"(\"+n.substr(0,3)+\") \"+n.substr(3,3)+\"-\"+n.substr(6)}var f=\"\";if(i=r.match(/^([#0?]+)( ?)\\/( ?)([#0?]+)/)){s=Math.min(i[4].length,7);l=re(o,Math.pow(10,s)-1,false);n=\"\"+c;f=Me(\"n\",i[1],l[1]);if(f.charAt(f.length-1)==\" \")f=f.substr(0,f.length-1)+\"0\";n+=f+i[2]+\"/\"+i[3];f=j(l[2],s);if(f.length<i[4].length)f=Ce(i[4].substr(i[4].length-f.length))+f;n+=f;return n}if(i=r.match(/^# ([#0?]+)( ?)\\/( ?)([#0?]+)/)){s=Math.min(Math.max(i[1].length,i[4].length),7);l=re(o,Math.pow(10,s)-1,true);return c+(l[0]||(l[1]?\"\":\"0\"))+\" \"+(l[1]?W(l[1],s)+i[2]+\"/\"+i[3]+j(l[2],s):xr(\" \",2*s+1+i[2].length+i[3].length))}if(i=r.match(/^[#0?]+$/)){n=G(t,0);if(r.length<=n.length)return n;return Ce(r.substr(0,r.length-n.length))+n}if(i=r.match(/^([#0?]+)\\.([#0]+)$/)){n=\"\"+t.toFixed(Math.min(i[2].length,10)).replace(/([^0])0+$/,\"$1\");s=n.indexOf(\".\");var u=r.indexOf(\".\")-s,h=r.length-n.length-u;return Ce(r.substr(0,u)+n+r.substr(r.length-h))}if(i=r.match(/^00,000\\.([#0]*0)$/)){s=_e(t,i[1].length);return t<0?\"-\"+Ee(e,r,-t):he(Te(t)).replace(/^\\d,\\d{3}$/,\"0$&\").replace(/^\\d*$/,function(e){return\"00,\"+(e.length<3?z(0,3-e.length):\"\")+e})+\".\"+z(s,i[1].length)}switch(r){case\"###,##0.00\":return Ee(e,\"#,##0.00\",t);case\"###,###\":;case\"##,###\":;case\"#,###\":var d=he(G(o,0));return d!==\"0\"?c+d:\"\";case\"###,###.00\":return Ee(e,\"###,##0.00\",t).replace(/^0\\./,\".\");case\"#,###.00\":return Ee(e,\"#,##0.00\",t).replace(/^0\\./,\".\");default:;}throw new Error(\"unsupported format |\"+r+\"|\")}function Fe(e,r,t){var a=r.length-1;while(r.charCodeAt(a-1)===44)--a;return Me(e,r.substr(0,a),t/Math.pow(10,3*(r.length-a)))}function De(e,r,t){var a=r.replace(de,\"\"),n=r.length-a.length;return Me(e,a,t*Math.pow(10,2*n))+xr(\"%\",n)}function Oe(e,r){var t;var a=e.indexOf(\"E\")-e.indexOf(\".\")-1;if(e.match(/^#+0.0E\\+0$/)){if(r==0)return\"0.0E+0\";else if(r<0)return\"-\"+Oe(e,-r);var n=e.indexOf(\".\");if(n===-1)n=e.indexOf(\"E\");var i=Math.floor(Math.log(r)*Math.LOG10E)%n;if(i<0)i+=n;t=(r/Math.pow(10,i)).toPrecision(a+1+(n+i)%n);if(!t.match(/[Ee]/)){var s=Math.floor(Math.log(r)*Math.LOG10E);if(t.indexOf(\".\")===-1)t=t.charAt(0)+\".\"+t.substr(1)+\"E+\"+(s-t.length+i);else t+=\"E+\"+(s-i);t=t.replace(/\\+-/,\"-\")}t=t.replace(/^([+-]?)(\\d*)\\.(\\d*)[Ee]/,function(e,r,t,a){return r+t+a.substr(0,(n+i)%n)+\".\"+a.substr(i)+\"E\"})}else t=r.toExponential(a);if(e.match(/E\\+00$/)&&t.match(/e[+-]\\d$/))t=t.substr(0,t.length-1)+\"0\"+t.charAt(t.length-1);if(e.match(/E\\-/)&&t.match(/e\\+/))t=t.replace(/e\\+/,\"e\");return t.replace(\"e\",\"E\")}function Ne(e,r,t){if(e.charCodeAt(0)===40&&!r.match(ye)){var a=r.replace(/\\( */,\"\").replace(/ \\)/,\"\").replace(/\\)/,\"\");if(t>=0)return Ne(\"n\",a,t);return\"(\"+Ne(\"n\",a,-t)+\")\"}if(r.charCodeAt(r.length-1)===44)return Fe(e,r,t);if(r.indexOf(\"%\")!==-1)return De(e,r,t);if(r.indexOf(\"E\")!==-1)return Oe(r,t);if(r.charCodeAt(0)===36)return\"$\"+Ne(e,r.substr(r.charAt(1)==\" \"?2:1),t);var n;var i,s,l,o=Math.abs(t),c=t<0?\"-\":\"\";if(r.match(/^00+$/))return c+z(o,r.length);if(r.match(/^[#?]+$/)){n=\"\"+t;if(t===0)n=\"\";return n.length>r.length?n:Ce(r.substr(0,r.length-n.length))+n}if(i=r.match(ge))return we(i,o,c);if(r.match(/^#+0+$/))return c+z(o,r.length-r.indexOf(\"0\"));if(i=r.match(ke)){n=(\"\"+t).replace(/^([^\\.]+)$/,\"$1.\"+Ce(i[1])).replace(/\\.$/,\".\"+Ce(i[1]));n=n.replace(/\\.(\\d*)$/,function(e,r){return\".\"+r+xr(\"0\",Ce(i[1]).length-r.length)});return r.indexOf(\"0.\")!==-1?n:n.replace(/^0\\./,\".\")}r=r.replace(/^#+([0.])/,\"$1\");if(i=r.match(/^(0*)\\.(#*)$/)){return c+(\"\"+o).replace(/\\.(\\d*[1-9])0*$/,\".$1\").replace(/^(-?\\d*)$/,\"$1.\").replace(/^0\\./,i[1].length?\"0.\":\".\")}if(i=r.match(/^#{1,3},##0(\\.?)$/))return c+he(\"\"+o);if(i=r.match(/^#,##0\\.([#0]*0)$/)){return t<0?\"-\"+Ne(e,r,-t):he(\"\"+t)+\".\"+xr(\"0\",i[1].length)}if(i=r.match(/^#,#*,#0/))return Ne(e,r.replace(/^#,#*,/,\"\"),t);if(i=r.match(/^([0#]+)(\\\\?-([0#]+))+$/)){n=B(Ne(e,r.replace(/[\\\\-]/g,\"\"),t));s=0;return B(B(r.replace(/\\\\/g,\"\")).replace(/[0#]/g,function(e){return s<n.length?n.charAt(s++):e===\"0\"?\"0\":\"\"}))}if(r.match(xe)){n=Ne(e,\"##########\",t);return\"(\"+n.substr(0,3)+\") \"+n.substr(3,3)+\"-\"+n.substr(6)}var f=\"\";if(i=r.match(/^([#0?]+)( ?)\\/( ?)([#0?]+)/)){s=Math.min(i[4].length,7);l=re(o,Math.pow(10,s)-1,false);n=\"\"+c;f=Me(\"n\",i[1],l[1]);if(f.charAt(f.length-1)==\" \")f=f.substr(0,f.length-1)+\"0\";n+=f+i[2]+\"/\"+i[3];f=j(l[2],s);if(f.length<i[4].length)f=Ce(i[4].substr(i[4].length-f.length))+f;n+=f;return n}if(i=r.match(/^# ([#0?]+)( ?)\\/( ?)([#0?]+)/)){s=Math.min(Math.max(i[1].length,i[4].length),7);l=re(o,Math.pow(10,s)-1,true);return c+(l[0]||(l[1]?\"\":\"0\"))+\" \"+(l[1]?W(l[1],s)+i[2]+\"/\"+i[3]+j(l[2],s):xr(\" \",2*s+1+i[2].length+i[3].length))}if(i=r.match(/^[#0?]+$/)){n=\"\"+t;if(r.length<=n.length)return n;return Ce(r.substr(0,r.length-n.length))+n}if(i=r.match(/^([#0]+)\\.([#0]+)$/)){n=\"\"+t.toFixed(Math.min(i[2].length,10)).replace(/([^0])0+$/,\"$1\");s=n.indexOf(\".\");var u=r.indexOf(\".\")-s,h=r.length-n.length-u;return Ce(r.substr(0,u)+n+r.substr(r.length-h))}if(i=r.match(/^00,000\\.([#0]*0)$/)){return t<0?\"-\"+Ne(e,r,-t):he(\"\"+t).replace(/^\\d,\\d{3}$/,\"0$&\").replace(/^\\d*$/,function(e){return\"00,\"+(e.length<3?z(0,3-e.length):\"\")+e})+\".\"+z(0,i[1].length)}switch(r){case\"###,###\":;case\"##,###\":;case\"#,###\":var d=he(\"\"+o);return d!==\"0\"?c+d:\"\";default:if(r.match(/\\.[0#?]*$/))return Ne(e,r.slice(0,r.lastIndexOf(\".\")),t)+Ce(r.slice(r.lastIndexOf(\".\")));}throw new Error(\"unsupported format |\"+r+\"|\")}function Me(e,r,t){return(t|0)===t?Ne(e,r,t):Ee(e,r,t)}function Ie(e){var r=[];var t=false;for(var a=0,n=0;a<e.length;++a)switch(e.charCodeAt(a)){case 34:t=!t;break;case 95:;case 42:;case 92:++a;break;case 59:r[r.length]=e.substr(n,a-n);n=a+1;}r[r.length]=e.substr(n);if(t===true)throw new Error(\"Format |\"+e+\"| unterminated string \");return r}var Pe=/\\[[HhMmSs\\u0E0A\\u0E19\\u0E17]*\\]/;function Re(e){var r=0,t=\"\",a=\"\";while(r<e.length){switch(t=e.charAt(r)){case\"G\":if(Y(e,r))r+=6;r++;break;case'\"':for(;e.charCodeAt(++r)!==34&&r<e.length;){}++r;break;case\"\\\\\":r+=2;break;case\"_\":r+=2;break;case\"@\":++r;break;case\"B\":;case\"b\":if(e.charAt(r+1)===\"1\"||e.charAt(r+1)===\"2\")return true;case\"M\":;case\"D\":;case\"Y\":;case\"H\":;case\"S\":;case\"E\":;case\"m\":;case\"d\":;case\"y\":;case\"h\":;case\"s\":;case\"e\":;case\"g\":return true;case\"A\":;case\"a\":;case\"上\":if(e.substr(r,3).toUpperCase()===\"A/P\")return true;if(e.substr(r,5).toUpperCase()===\"AM/PM\")return true;if(e.substr(r,5).toUpperCase()===\"上午/下午\")return true;++r;break;case\"[\":a=t;while(e.charAt(r++)!==\"]\"&&r<e.length)a+=e.charAt(r);if(a.match(Pe))return true;break;case\".\":;case\"0\":;case\"#\":while(r<e.length&&(\"0#?.,E+-%\".indexOf(t=e.charAt(++r))>-1||t==\"\\\\\"&&e.charAt(r+1)==\"-\"&&\"0#\".indexOf(e.charAt(r+2))>-1)){}break;case\"?\":while(e.charAt(++r)===t){}break;case\"*\":++r;if(e.charAt(r)==\" \"||e.charAt(r)==\"*\")++r;break;case\"(\":;case\")\":++r;break;case\"1\":;case\"2\":;case\"3\":;case\"4\":;case\"5\":;case\"6\":;case\"7\":;case\"8\":;case\"9\":while(r<e.length&&\"0123456789\".indexOf(e.charAt(++r))>-1){}break;case\" \":++r;break;default:++r;break;}}return false}function Le(e,r,t,a){var n=[],i=\"\",s=0,l=\"\",o=\"t\",c,f,u;var h=\"H\";while(s<e.length){switch(l=e.charAt(s)){case\"G\":if(!Y(e,s))throw new Error(\"unrecognized character \"+l+\" in \"+e);n[n.length]={t:\"G\",v:\"General\"};s+=7;break;case'\"':for(i=\"\";(u=e.charCodeAt(++s))!==34&&s<e.length;)i+=String.fromCharCode(u);n[n.length]={t:\"t\",v:i};++s;break;case\"\\\\\":var d=e.charAt(++s),p=d===\"(\"||d===\")\"?d:\"t\";n[n.length]={t:p,v:d};++s;break;case\"_\":n[n.length]={t:\"t\",v:\" \"};s+=2;break;case\"@\":n[n.length]={t:\"T\",v:r};++s;break;case\"B\":;case\"b\":if(e.charAt(s+1)===\"1\"||e.charAt(s+1)===\"2\"){if(c==null){c=ae(r,t,e.charAt(s+1)===\"2\");if(c==null)return\"\"}n[n.length]={t:\"X\",v:e.substr(s,2)};o=l;s+=2;break};case\"M\":;case\"D\":;case\"Y\":;case\"H\":;case\"S\":;case\"E\":l=l.toLowerCase();case\"m\":;case\"d\":;case\"y\":;case\"h\":;case\"s\":;case\"e\":;case\"g\":if(r<0)return\"\";if(c==null){c=ae(r,t);if(c==null)return\"\"}i=l;while(++s<e.length&&e.charAt(s).toLowerCase()===l)i+=l;if(l===\"m\"&&o.toLowerCase()===\"h\")l=\"M\";if(l===\"h\")l=h;n[n.length]={t:l,v:i};o=l;break;case\"A\":;case\"a\":;case\"上\":var m={t:l,v:l};if(c==null)c=ae(r,t);if(e.substr(s,3).toUpperCase()===\"A/P\"){if(c!=null)m.v=c.H>=12?e.charAt(s+2):l;m.t=\"T\";h=\"h\";s+=3}else if(e.substr(s,5).toUpperCase()===\"AM/PM\"){if(c!=null)m.v=c.H>=12?\"PM\":\"AM\";m.t=\"T\";s+=5;h=\"h\"}else if(e.substr(s,5).toUpperCase()===\"上午/下午\"){if(c!=null)m.v=c.H>=12?\"下午\":\"上午\";m.t=\"T\";s+=5;h=\"h\"}else{m.t=\"t\";++s}if(c==null&&m.t===\"T\")return\"\";n[n.length]=m;o=l;break;case\"[\":i=l;while(e.charAt(s++)!==\"]\"&&s<e.length)i+=e.charAt(s);if(i.slice(-1)!==\"]\")throw'unterminated \"[\" block: |'+i+\"|\";if(i.match(Pe)){if(c==null){c=ae(r,t);if(c==null)return\"\"}n[n.length]={t:\"Z\",v:i.toLowerCase()};o=i.charAt(1)}else if(i.indexOf(\"$\")>-1){i=(i.match(/\\$([^-\\[\\]]*)/)||[])[1]||\"$\";if(!Re(e))n[n.length]={t:\"t\",v:i}}break;case\".\":if(c!=null){i=l;while(++s<e.length&&(l=e.charAt(s))===\"0\")i+=l;n[n.length]={t:\"s\",v:i};break};case\"0\":;case\"#\":i=l;while(++s<e.length&&\"0#?.,E+-%\".indexOf(l=e.charAt(s))>-1)i+=l;n[n.length]={t:\"n\",v:i};break;case\"?\":i=l;while(e.charAt(++s)===l)i+=l;n[n.length]={t:l,v:i};o=l;break;case\"*\":++s;if(e.charAt(s)==\" \"||e.charAt(s)==\"*\")++s;break;case\"(\":;case\")\":n[n.length]={t:a===1?\"t\":l,v:l};++s;break;case\"1\":;case\"2\":;case\"3\":;case\"4\":;case\"5\":;case\"6\":;case\"7\":;case\"8\":;case\"9\":i=l;while(s<e.length&&\"0123456789\".indexOf(e.charAt(++s))>-1)i+=e.charAt(s);n[n.length]={t:\"D\",v:i};break;case\" \":n[n.length]={t:l,v:l};++s;break;case\"$\":n[n.length]={t:\"t\",v:\"$\"};++s;break;default:if(\",$-+/():!^&'~{}<>=€acfijklopqrtuvwxzP\".indexOf(l)===-1)throw new Error(\"unrecognized character \"+l+\" in \"+e);n[n.length]={t:\"t\",v:l};++s;break;}}var v=0,g=0,b;for(s=n.length-1,o=\"t\";s>=0;--s){switch(n[s].t){case\"h\":;case\"H\":n[s].t=h;o=\"h\";if(v<1)v=1;break;case\"s\":if(b=n[s].v.match(/\\.0+$/)){g=Math.max(g,b[0].length-1);v=4}if(v<3)v=3;case\"d\":;case\"y\":;case\"e\":o=n[s].t;break;case\"M\":o=n[s].t;if(v<2)v=2;break;case\"m\":if(o===\"s\"){n[s].t=\"M\";if(v<2)v=2}break;case\"X\":break;case\"Z\":if(v<1&&n[s].v.match(/[Hh]/))v=1;if(v<2&&n[s].v.match(/[Mm]/))v=2;if(v<3&&n[s].v.match(/[Ss]/))v=3;}}var w;switch(v){case 0:break;case 1:;case 2:;case 3:if(c.u>=.5){c.u=0;++c.S}if(c.S>=60){c.S=0;++c.M}if(c.M>=60){c.M=0;++c.H}if(c.H>=24){c.H=0;++c.D;w=ae(c.D);w.u=c.u;w.S=c.S;w.M=c.M;w.H=c.H;c=w}break;case 4:switch(g){case 1:c.u=Math.round(c.u*10)/10;break;case 2:c.u=Math.round(c.u*100)/100;break;case 3:c.u=Math.round(c.u*1e3)/1e3;break;}if(c.u>=1){c.u=0;++c.S}if(c.S>=60){c.S=0;++c.M}if(c.M>=60){c.M=0;++c.H}if(c.H>=24){c.H=0;++c.D;w=ae(c.D);w.u=c.u;w.S=c.S;w.M=c.M;w.H=c.H;c=w}break;}var k=\"\",y;for(s=0;s<n.length;++s){switch(n[s].t){case\"t\":;case\"T\":;case\" \":;case\"D\":break;case\"X\":n[s].v=\"\";n[s].t=\";\";break;case\"d\":;case\"m\":;case\"y\":;case\"h\":;case\"H\":;case\"M\":;case\"s\":;case\"e\":;case\"b\":;case\"Z\":n[s].v=ue(n[s].t.charCodeAt(0),n[s].v,c,g);n[s].t=\"t\";break;case\"n\":;case\"?\":y=s+1;while(n[y]!=null&&((l=n[y].t)===\"?\"||l===\"D\"||(l===\" \"||l===\"t\")&&n[y+1]!=null&&(n[y+1].t===\"?\"||n[y+1].t===\"t\"&&n[y+1].v===\"/\")||n[s].t===\"(\"&&(l===\" \"||l===\"n\"||l===\")\")||l===\"t\"&&(n[y].v===\"/\"||n[y].v===\" \"&&n[y+1]!=null&&n[y+1].t==\"?\"))){n[s].v+=n[y].v;n[y]={v:\"\",t:\";\"};++y}k+=n[s].v;s=y-1;break;case\"G\":n[s].t=\"t\";n[s].v=ce(r,t);break;}}var x=\"\",C,S;if(k.length>0){if(k.charCodeAt(0)==40){C=r<0&&k.charCodeAt(0)===45?-r:r;S=Me(\"n\",k,C)}else{C=r<0&&a>1?-r:r;S=Me(\"n\",k,C);if(C<0&&n[0]&&n[0].t==\"t\"){S=S.substr(1);n[0].v=\"-\"+n[0].v}}y=S.length-1;var _=n.length;for(s=0;s<n.length;++s)if(n[s]!=null&&n[s].t!=\"t\"&&n[s].v.indexOf(\".\")>-1){_=s;break}var A=n.length;if(_===n.length&&S.indexOf(\"E\")===-1){for(s=n.length-1;s>=0;--s){if(n[s]==null||\"n?\".indexOf(n[s].t)===-1)continue;if(y>=n[s].v.length-1){y-=n[s].v.length;n[s].v=S.substr(y+1,n[s].v.length)}else if(y<0)n[s].v=\"\";else{n[s].v=S.substr(0,y+1);y=-1}n[s].t=\"t\";A=s}if(y>=0&&A<n.length)n[A].v=S.substr(0,y+1)+n[A].v}else if(_!==n.length&&S.indexOf(\"E\")===-1){y=S.indexOf(\".\")-1;for(s=_;s>=0;--s){if(n[s]==null||\"n?\".indexOf(n[s].t)===-1)continue;f=n[s].v.indexOf(\".\")>-1&&s===_?n[s].v.indexOf(\".\")-1:n[s].v.length-1;x=n[s].v.substr(f+1);for(;f>=0;--f){if(y>=0&&(n[s].v.charAt(f)===\"0\"||n[s].v.charAt(f)===\"#\"))x=S.charAt(y--)+x}n[s].v=x;n[s].t=\"t\";A=s}if(y>=0&&A<n.length)n[A].v=S.substr(0,y+1)+n[A].v;y=S.indexOf(\".\")+1;for(s=_;s<n.length;++s){if(n[s]==null||\"n?(\".indexOf(n[s].t)===-1&&s!==_)continue;f=n[s].v.indexOf(\".\")>-1&&s===_?n[s].v.indexOf(\".\")+1:0;x=n[s].v.substr(0,f);for(;f<n[s].v.length;++f){if(y<S.length)x+=S.charAt(y++)}n[s].v=x;n[s].t=\"t\";A=s}}}for(s=0;s<n.length;++s)if(n[s]!=null&&\"n?\".indexOf(n[s].t)>-1){C=a>1&&r<0&&s>0&&n[s-1].v===\"-\"?-r:r;n[s].v=Me(n[s].t,n[s].v,C);n[s].t=\"t\"}var T=\"\";for(s=0;s!==n.length;++s)if(n[s]!=null)T+=n[s].v;return T}var Ue=/\\[(=|>[=]?|<[>=]?)(-?\\d+(?:\\.\\d*)?)\\]/;function Be(e,r){if(r==null)return false;var t=parseFloat(r[2]);switch(r[1]){case\"=\":if(e==t)return true;break;case\">\":if(e>t)return true;break;case\"<\":if(e<t)return true;break;case\"<>\":if(e!=t)return true;break;case\">=\":if(e>=t)return true;break;case\"<=\":if(e<=t)return true;break;}return false}function ze(e,r){var t=Ie(e);var a=t.length,n=t[a-1].indexOf(\"@\");if(a<4&&n>-1)--a;if(t.length>4)throw new Error(\"cannot find right format for |\"+t.join(\"|\")+\"|\");if(typeof r!==\"number\")return[4,t.length===4||n>-1?t[t.length-1]:\"@\"];if(typeof r===\"number\"&&!isFinite(r))r=0;switch(t.length){case 1:t=n>-1?[\"General\",\"General\",\"General\",t[0]]:[t[0],t[0],t[0],\"@\"];break;case 2:t=n>-1?[t[0],t[0],t[0],t[1]]:[t[0],t[1],t[0],\"@\"];break;case 3:t=n>-1?[t[0],t[1],t[0],t[2]]:[t[0],t[1],t[2],\"@\"];break;case 4:break;}var i=r>0?t[0]:r<0?t[1]:t[2];if(t[0].indexOf(\"[\")===-1&&t[1].indexOf(\"[\")===-1)return[a,i];if(t[0].match(/\\[[=<>]/)!=null||t[1].match(/\\[[=<>]/)!=null){var s=t[0].match(Ue);var l=t[1].match(Ue);return Be(r,s)?[a,t[0]]:Be(r,l)?[a,t[1]]:[a,t[s!=null&&l!=null?2:1]]}return[a,i]}function $e(e,r,t){if(t==null)t={};var a=\"\";switch(typeof e){case\"string\":if(e==\"m/d/yy\"&&t.dateNF)a=t.dateNF;else a=e;break;case\"number\":if(e==14&&t.dateNF)a=t.dateNF;else a=(t.table!=null?t.table:q)[e];if(a==null)a=t.table&&t.table[Q[e]]||q[Q[e]];if(a==null)a=ee[e]||\"General\";break;}if(Y(a,0))return ce(r,t);if(r instanceof Date)r=dr(r,t.date1904);var n=ze(a,r);if(Y(n[1]))return ce(r,t);if(r===true)r=\"TRUE\";else if(r===false)r=\"FALSE\";else if(r===\"\"||r==null)return\"\";else if(isNaN(r)&&n[1].indexOf(\"0\")>-1)return\"#NUM!\";else if(!isFinite(r)&&n[1].indexOf(\"0\")>-1)return\"#DIV/0!\";return Le(n[1],r,t,n[0])}function We(e,r){if(typeof r!=\"number\"){r=+r||-1;for(var t=0;t<392;++t){if(q[t]==undefined){if(r<0)r=t;continue}if(q[t]==e){r=t;break}}if(r<0)r=391}q[r]=e;return r}function je(e){for(var r=0;r!=392;++r)if(e[r]!==undefined)We(e[r],r)}function He(){q=K()}var Ve={format:$e,load:We,_table:q,load_table:je,parse_date_code:ae,is_date:Re,get_table:function Mc(){return Ve._table=q}};var Xe={5:'\"$\"#,##0_);\\\\(\"$\"#,##0\\\\)',6:'\"$\"#,##0_);[Red]\\\\(\"$\"#,##0\\\\)',7:'\"$\"#,##0.00_);\\\\(\"$\"#,##0.00\\\\)',8:'\"$\"#,##0.00_);[Red]\\\\(\"$\"#,##0.00\\\\)',23:\"General\",24:\"General\",25:\"General\",26:\"General\",27:\"m/d/yy\",28:\"m/d/yy\",29:\"m/d/yy\",30:\"m/d/yy\",31:\"m/d/yy\",32:\"h:mm:ss\",33:\"h:mm:ss\",34:\"h:mm:ss\",35:\"h:mm:ss\",36:\"m/d/yy\",41:'_(* #,##0_);_(* (#,##0);_(* \"-\"_);_(@_)',42:'_(\"$\"* #,##0_);_(\"$\"* (#,##0);_(\"$\"* \"-\"_);_(@_)',43:'_(* #,##0.00_);_(* (#,##0.00);_(* \"-\"??_);_(@_)',44:'_(\"$\"* #,##0.00_);_(\"$\"* (#,##0.00);_(\"$\"* \"-\"??_);_(@_)',50:\"m/d/yy\",51:\"m/d/yy\",52:\"m/d/yy\",53:\"m/d/yy\",54:\"m/d/yy\",55:\"m/d/yy\",56:\"m/d/yy\",57:\"m/d/yy\",58:\"m/d/yy\",59:\"0\",60:\"0.00\",61:\"#,##0\",62:\"#,##0.00\",63:'\"$\"#,##0_);\\\\(\"$\"#,##0\\\\)',64:'\"$\"#,##0_);[Red]\\\\(\"$\"#,##0\\\\)',65:'\"$\"#,##0.00_);\\\\(\"$\"#,##0.00\\\\)',66:'\"$\"#,##0.00_);[Red]\\\\(\"$\"#,##0.00\\\\)',67:\"0%\",68:\"0.00%\",69:\"# ?/?\",70:\"# ??/??\",71:\"m/d/yy\",72:\"m/d/yy\",73:\"d-mmm-yy\",74:\"d-mmm\",75:\"mmm-yy\",76:\"h:mm\",77:\"h:mm:ss\",78:\"m/d/yy h:mm\",79:\"mm:ss\",80:\"[h]:mm:ss\",81:\"mmss.0\"};var Ge=/[dD]+|[mM]+|[yYeE]+|[Hh]+|[Ss]+/g;function Ye(e){var r=typeof e==\"number\"?q[e]:e;r=r.replace(Ge,\"(\\\\d+)\");Ge.lastIndex=0;return new RegExp(\"^\"+r+\"$\");\n}function Je(e,r,t){var a=-1,n=-1,i=-1,s=-1,l=-1,o=-1;(r.match(Ge)||[]).forEach(function(e,r){var c=parseInt(t[r+1],10);switch(e.toLowerCase().charAt(0)){case\"y\":a=c;break;case\"d\":i=c;break;case\"h\":s=c;break;case\"s\":o=c;break;case\"m\":if(s>=0)l=c;else n=c;break;}});Ge.lastIndex=0;if(o>=0&&l==-1&&n>=0){l=n;n=-1}var c=(\"\"+(a>=0?a:(new Date).getFullYear())).slice(-4)+\"-\"+(\"00\"+(n>=1?n:1)).slice(-2)+\"-\"+(\"00\"+(i>=1?i:1)).slice(-2);if(c.length==7)c=\"0\"+c;if(c.length==8)c=\"20\"+c;var f=(\"00\"+(s>=0?s:0)).slice(-2)+\":\"+(\"00\"+(l>=0?l:0)).slice(-2)+\":\"+(\"00\"+(o>=0?o:0)).slice(-2);if(s==-1&&l==-1&&o==-1)return c;if(a==-1&&n==-1&&i==-1)return f;return c+\"T\"+f}var Ze={\"d.m\":\"d\\\\.m\"};function Ke(e,r){return We(Ze[e]||e,r)}var qe=function(){var e={};e.version=\"1.2.0\";function r(){var e=0,r=new Array(256);for(var t=0;t!=256;++t){e=t;e=e&1?-306674912^e>>>1:e>>>1;e=e&1?-306674912^e>>>1:e>>>1;e=e&1?-306674912^e>>>1:e>>>1;e=e&1?-306674912^e>>>1:e>>>1;e=e&1?-306674912^e>>>1:e>>>1;e=e&1?-306674912^e>>>1:e>>>1;e=e&1?-306674912^e>>>1:e>>>1;e=e&1?-306674912^e>>>1:e>>>1;r[t]=e}return typeof Int32Array!==\"undefined\"?new Int32Array(r):r}var t=r();function a(e){var r=0,t=0,a=0,n=typeof Int32Array!==\"undefined\"?new Int32Array(4096):new Array(4096);for(a=0;a!=256;++a)n[a]=e[a];for(a=0;a!=256;++a){t=e[a];for(r=256+a;r<4096;r+=256)t=n[r]=t>>>8^e[t&255]}var i=[];for(a=1;a!=16;++a)i[a-1]=typeof Int32Array!==\"undefined\"&&typeof n.subarray==\"function\"?n.subarray(a*256,a*256+256):n.slice(a*256,a*256+256);return i}var n=a(t);var i=n[0],s=n[1],l=n[2],o=n[3],c=n[4];var f=n[5],u=n[6],h=n[7],d=n[8],p=n[9];var m=n[10],v=n[11],g=n[12],b=n[13],w=n[14];function k(e,r){var a=r^-1;for(var n=0,i=e.length;n<i;)a=a>>>8^t[(a^e.charCodeAt(n++))&255];return~a}function y(e,r){var a=r^-1,n=e.length-15,k=0;for(;k<n;)a=w[e[k++]^a&255]^b[e[k++]^a>>8&255]^g[e[k++]^a>>16&255]^v[e[k++]^a>>>24]^m[e[k++]]^p[e[k++]]^d[e[k++]]^h[e[k++]]^u[e[k++]]^f[e[k++]]^c[e[k++]]^o[e[k++]]^l[e[k++]]^s[e[k++]]^i[e[k++]]^t[e[k++]];n+=15;while(k<n)a=a>>>8^t[(a^e[k++])&255];return~a}function x(e,r){var a=r^-1;for(var n=0,i=e.length,s=0,l=0;n<i;){s=e.charCodeAt(n++);if(s<128){a=a>>>8^t[(a^s)&255]}else if(s<2048){a=a>>>8^t[(a^(192|s>>6&31))&255];a=a>>>8^t[(a^(128|s&63))&255]}else if(s>=55296&&s<57344){s=(s&1023)+64;l=e.charCodeAt(n++)&1023;a=a>>>8^t[(a^(240|s>>8&7))&255];a=a>>>8^t[(a^(128|s>>2&63))&255];a=a>>>8^t[(a^(128|l>>6&15|(s&3)<<4))&255];a=a>>>8^t[(a^(128|l&63))&255]}else{a=a>>>8^t[(a^(224|s>>12&15))&255];a=a>>>8^t[(a^(128|s>>6&63))&255];a=a>>>8^t[(a^(128|s&63))&255]}}return~a}e.table=t;e.bstr=k;e.buf=y;e.str=x;return e}();var Qe=function Ic(){var e={};e.version=\"1.2.2\";function r(e,r){var t=e.split(\"/\"),a=r.split(\"/\");for(var n=0,i=0,s=Math.min(t.length,a.length);n<s;++n){if(i=t[n].length-a[n].length)return i;if(t[n]!=a[n])return t[n]<a[n]?-1:1}return t.length-a.length}function t(e){if(e.charAt(e.length-1)==\"/\")return e.slice(0,-1).indexOf(\"/\")===-1?e:t(e.slice(0,-1));var r=e.lastIndexOf(\"/\");return r===-1?e:e.slice(0,r+1)}function a(e){if(e.charAt(e.length-1)==\"/\")return a(e.slice(0,-1));var r=e.lastIndexOf(\"/\");return r===-1?e:e.slice(r+1)}function n(e,r){if(typeof r===\"string\")r=new Date(r);var t=r.getHours();t=t<<6|r.getMinutes();t=t<<5|r.getSeconds()>>>1;e._W(2,t);var a=r.getFullYear()-1980;a=a<<4|r.getMonth()+1;a=a<<5|r.getDate();e._W(2,a)}function i(e){var r=e._R(2)&65535;var t=e._R(2)&65535;var a=new Date;var n=t&31;t>>>=5;var i=t&15;t>>>=4;a.setMilliseconds(0);a.setFullYear(t+1980);a.setMonth(i-1);a.setDate(n);var s=r&31;r>>>=5;var l=r&63;r>>>=6;a.setHours(r);a.setMinutes(l);a.setSeconds(s<<1);return a}function s(e){Fa(e,0);var r={};var t=0;while(e.l<=e.length-4){var a=e._R(2);var n=e._R(2),i=e.l+n;var s={};switch(a){case 21589:{t=e._R(1);if(t&1)s.mtime=e._R(4);if(n>5){if(t&2)s.atime=e._R(4);if(t&4)s.ctime=e._R(4)}if(s.mtime)s.mt=new Date(s.mtime*1e3)}break;case 1:{var l=e._R(4),o=e._R(4);s.usz=o*Math.pow(2,32)+l;l=e._R(4);o=e._R(4);s.csz=o*Math.pow(2,32)+l}break;}e.l=i;r[a]=s}return r}var l;function o(){return l||(l=er)}function c(e,r){if(e[0]==80&&e[1]==75)return Oe(e,r);if((e[0]|32)==109&&(e[1]|32)==105)return ze(e,r);if(e.length<512)throw new Error(\"CFB file size \"+e.length+\" < 512\");var t=3;var a=512;var n=0;var i=0;var s=0;var l=0;var o=0;var c=[];var p=e.slice(0,512);Fa(p,0);var v=f(p);t=v[0];switch(t){case 3:a=512;break;case 4:a=4096;break;case 0:if(v[1]==0)return Oe(e,r);default:throw new Error(\"Major Version: Expected 3 or 4 saw \"+t);}if(a!==512){p=e.slice(0,a);Fa(p,28)}var w=e.slice(0,a);u(p,t);var k=p._R(4,\"i\");if(t===3&&k!==0)throw new Error(\"# Directory Sectors: Expected 0 saw \"+k);p.l+=4;s=p._R(4,\"i\");p.l+=4;p.chk(\"00100000\",\"Mini Stream Cutoff Size: \");l=p._R(4,\"i\");n=p._R(4,\"i\");o=p._R(4,\"i\");i=p._R(4,\"i\");for(var y=-1,x=0;x<109;++x){y=p._R(4,\"i\");if(y<0)break;c[x]=y}var C=h(e,a);m(o,i,C,a,c);var S=g(C,s,c,a);if(s<S.length)S[s].name=\"!Directory\";if(n>0&&l!==R)S[l].name=\"!MiniFAT\";S[c[0]].name=\"!FAT\";S.fat_addrs=c;S.ssz=a;var _={},A=[],T=[],E=[];b(s,S,C,A,n,_,T,l);d(T,E,A);A.shift();var F={FileIndex:T,FullPaths:E};if(r&&r.raw)F.raw={header:w,sectors:C};return F}function f(e){if(e[e.l]==80&&e[e.l+1]==75)return[0,0];e.chk(B,\"Header Signature: \");e.l+=16;var r=e._R(2,\"u\");return[e._R(2,\"u\"),r]}function u(e,r){var t=9;e.l+=2;switch(t=e._R(2)){case 9:if(r!=3)throw new Error(\"Sector Shift: Expected 9 saw \"+t);break;case 12:if(r!=4)throw new Error(\"Sector Shift: Expected 12 saw \"+t);break;default:throw new Error(\"Sector Shift: Expected 9 or 12 saw \"+t);}e.chk(\"0600\",\"Mini Sector Shift: \");e.chk(\"000000000000\",\"Reserved: \")}function h(e,r){var t=Math.ceil(e.length/r)-1;var a=[];for(var n=1;n<t;++n)a[n-1]=e.slice(n*r,(n+1)*r);a[t-1]=e.slice(t*r);return a}function d(e,r,t){var a=0,n=0,i=0,s=0,l=0,o=t.length;var c=[],f=[];for(;a<o;++a){c[a]=f[a]=a;r[a]=t[a]}for(;l<f.length;++l){a=f[l];n=e[a].L;i=e[a].R;s=e[a].C;if(c[a]===a){if(n!==-1&&c[n]!==n)c[a]=c[n];if(i!==-1&&c[i]!==i)c[a]=c[i]}if(s!==-1)c[s]=a;if(n!==-1&&a!=c[a]){c[n]=c[a];if(f.lastIndexOf(n)<l)f.push(n)}if(i!==-1&&a!=c[a]){c[i]=c[a];if(f.lastIndexOf(i)<l)f.push(i)}}for(a=1;a<o;++a)if(c[a]===a){if(i!==-1&&c[i]!==i)c[a]=c[i];else if(n!==-1&&c[n]!==n)c[a]=c[n]}for(a=1;a<o;++a){if(e[a].type===0)continue;l=a;if(l!=c[l])do{l=c[l];r[a]=r[l]+\"/\"+r[a]}while(l!==0&&-1!==c[l]&&l!=c[l]);c[a]=-1}r[0]+=\"/\";for(a=1;a<o;++a){if(e[a].type!==2)r[a]+=\"/\"}}function p(e,r,t){var a=e.start,n=e.size;var i=[];var s=a;while(t&&n>0&&s>=0){i.push(r.slice(s*I,s*I+I));n-=I;s=ya(t,s*4)}if(i.length===0)return Oa(0);return P(i).slice(0,e.size)}function m(e,r,t,a,n){var i=R;if(e===R){if(r!==0)throw new Error(\"DIFAT chain shorter than expected\")}else if(e!==-1){var s=t[e],l=(a>>>2)-1;if(!s)return;for(var o=0;o<l;++o){if((i=ya(s,o*4))===R)break;n.push(i)}if(r>=1)m(ya(s,a-4),r-1,t,a,n)}}function v(e,r,t,a,n){var i=[],s=[];if(!n)n=[];var l=a-1,o=0,c=0;for(o=r;o>=0;){n[o]=true;i[i.length]=o;s.push(e[o]);var f=t[Math.floor(o*4/a)];c=o*4&l;if(a<4+c)throw new Error(\"FAT boundary crossed: \"+o+\" 4 \"+a);if(!e[f])break;o=ya(e[f],c)}return{nodes:i,data:Zt([s])}}function g(e,r,t,a){var n=e.length,i=[];var s=[],l=[],o=[];var c=a-1,f=0,u=0,h=0,d=0;for(f=0;f<n;++f){l=[];h=f+r;if(h>=n)h-=n;if(s[h])continue;o=[];var p=[];for(u=h;u>=0;){p[u]=true;s[u]=true;l[l.length]=u;o.push(e[u]);var m=t[Math.floor(u*4/a)];d=u*4&c;if(a<4+d)throw new Error(\"FAT boundary crossed: \"+u+\" 4 \"+a);if(!e[m])break;u=ya(e[m],d);if(p[u])break}i[h]={nodes:l,data:Zt([o])}}return i}function b(e,r,t,a,n,i,s,l){var o=0,c=a.length?2:0;var f=r[e].data;var u=0,h=0,d;for(;u<f.length;u+=128){var m=f.slice(u,u+128);Fa(m,64);h=m._R(2);d=qt(m,0,h-c);a.push(d);var g={name:d,type:m._R(1),color:m._R(1),L:m._R(4,\"i\"),R:m._R(4,\"i\"),C:m._R(4,\"i\"),clsid:m._R(16),state:m._R(4,\"i\"),start:0,size:0};var b=m._R(2)+m._R(2)+m._R(2)+m._R(2);if(b!==0)g.ct=w(m,m.l-8);var k=m._R(2)+m._R(2)+m._R(2)+m._R(2);if(k!==0)g.mt=w(m,m.l-8);g.start=m._R(4,\"i\");g.size=m._R(4,\"i\");if(g.size<0&&g.start<0){g.size=g.type=0;g.start=R;g.name=\"\"}if(g.type===5){o=g.start;if(n>0&&o!==R)r[o].name=\"!StreamData\"}else if(g.size>=4096){g.storage=\"fat\";if(r[g.start]===undefined)r[g.start]=v(t,g.start,r.fat_addrs,r.ssz);r[g.start].name=g.name;g.content=r[g.start].data.slice(0,g.size)}else{g.storage=\"minifat\";if(g.size<0)g.size=0;else if(o!==R&&g.start!==R&&r[o]){g.content=p(g,r[o].data,(r[l]||{}).data)}}if(g.content)Fa(g.content,0);i[d]=g;s.push(g)}}function w(e,r){return new Date((ka(e,r+4)/1e7*Math.pow(2,32)+ka(e,r)/1e7-11644473600)*1e3)}function k(e,r){o();return c(l.readFileSync(e),r)}function x(e,r){var t=r&&r.type;if(!t){if(_&&Buffer.isBuffer(e))t=\"buffer\"}switch(t||\"base64\"){case\"file\":return k(e,r);case\"base64\":return c(D(S(e)),r);case\"binary\":return c(D(e),r);}return c(e,r)}function C(e,r){var t=r||{},a=t.root||\"Root Entry\";if(!e.FullPaths)e.FullPaths=[];if(!e.FileIndex)e.FileIndex=[];if(e.FullPaths.length!==e.FileIndex.length)throw new Error(\"inconsistent CFB structure\");if(e.FullPaths.length===0){e.FullPaths[0]=a+\"/\";e.FileIndex[0]={name:a,type:5}}if(t.CLSID)e.FileIndex[0].clsid=t.CLSID;T(e)}function T(e){var r=\"\u0001Sh33tJ5\";if(Qe.find(e,\"/\"+r))return;var t=Oa(4);t[0]=55;t[1]=t[3]=50;t[2]=54;e.FileIndex.push({name:r,type:2,content:t,size:4,L:69,R:69,C:69});e.FullPaths.push(e.FullPaths[0]+r);O(e)}function O(e,n){C(e);var i=false,s=false;for(var l=e.FullPaths.length-1;l>=0;--l){var o=e.FileIndex[l];switch(o.type){case 0:if(s)i=true;else{e.FileIndex.pop();e.FullPaths.pop()}break;case 1:;case 2:;case 5:s=true;if(isNaN(o.R*o.L*o.C))i=true;if(o.R>-1&&o.L>-1&&o.R==o.L)i=true;break;default:i=true;break;}}if(!i&&!n)return;var c=new Date(1987,1,19),f=0;var u=Object.create?Object.create(null):{};var h=[];for(l=0;l<e.FullPaths.length;++l){u[e.FullPaths[l]]=true;if(e.FileIndex[l].type===0)continue;h.push([e.FullPaths[l],e.FileIndex[l]])}for(l=0;l<h.length;++l){var d=t(h[l][0]);s=u[d];while(!s){while(t(d)&&!u[t(d)])d=t(d);h.push([d,{name:a(d).replace(\"/\",\"\"),type:1,clsid:$,ct:c,mt:c,content:null}]);u[d]=true;d=t(h[l][0]);s=u[d]}}h.sort(function(e,t){return r(e[0],t[0])});e.FullPaths=[];e.FileIndex=[];for(l=0;l<h.length;++l){e.FullPaths[l]=h[l][0];e.FileIndex[l]=h[l][1]}for(l=0;l<h.length;++l){var p=e.FileIndex[l];var m=e.FullPaths[l];p.name=a(m).replace(\"/\",\"\");p.L=p.R=p.C=-(p.color=1);p.size=p.content?p.content.length:0;p.start=0;p.clsid=p.clsid||$;if(l===0){p.C=h.length>1?1:-1;p.size=0;p.type=5}else if(m.slice(-1)==\"/\"){for(f=l+1;f<h.length;++f)if(t(e.FullPaths[f])==m)break;p.C=f>=h.length?-1:f;for(f=l+1;f<h.length;++f)if(t(e.FullPaths[f])==t(m))break;p.R=f>=h.length?-1:f;p.type=1}else{if(t(e.FullPaths[l+1]||\"\")==t(m))p.R=l+1;p.type=2}}}function N(e,r){var t=r||{};if(t.fileType==\"mad\")return $e(e,t);O(e);switch(t.fileType){case\"zip\":return Me(e,t);}var a=function(e){var r=0,t=0;for(var a=0;a<e.FileIndex.length;++a){var n=e.FileIndex[a];if(!n.content)continue;var i=n.content.length;if(i>0){if(i<4096)r+=i+63>>6;else t+=i+511>>9}}var s=e.FullPaths.length+3>>2;var l=r+7>>3;var o=r+127>>7;var c=l+t+s+o;var f=c+127>>7;var u=f<=109?0:Math.ceil((f-109)/127);while(c+f+u+127>>7>f)u=++f<=109?0:Math.ceil((f-109)/127);var h=[1,u,f,o,s,t,r,0];e.FileIndex[0].size=r<<6;h[7]=(e.FileIndex[0].start=h[0]+h[1]+h[2]+h[3]+h[4]+h[5])+(h[6]+7>>3);return h}(e);var n=Oa(a[7]<<9);var i=0,s=0;{for(i=0;i<8;++i)n._W(1,z[i]);for(i=0;i<8;++i)n._W(2,0);n._W(2,62);n._W(2,3);n._W(2,65534);n._W(2,9);n._W(2,6);for(i=0;i<3;++i)n._W(2,0);n._W(4,0);n._W(4,a[2]);n._W(4,a[0]+a[1]+a[2]+a[3]-1);n._W(4,0);n._W(4,1<<12);n._W(4,a[3]?a[0]+a[1]+a[2]-1:R);n._W(4,a[3]);n._W(-4,a[1]?a[0]-1:R);n._W(4,a[1]);for(i=0;i<109;++i)n._W(-4,i<a[2]?a[1]+i:-1)}if(a[1]){for(s=0;s<a[1];++s){for(;i<236+s*127;++i)n._W(-4,i<a[2]?a[1]+i:-1);n._W(-4,s===a[1]-1?R:s+1)}}var l=function(e){for(s+=e;i<s-1;++i)n._W(-4,i+1);if(e){++i;n._W(-4,R)}};s=i=0;for(s+=a[1];i<s;++i)n._W(-4,W.DIFSECT);for(s+=a[2];i<s;++i)n._W(-4,W.FATSECT);l(a[3]);l(a[4]);var o=0,c=0;var f=e.FileIndex[0];for(;o<e.FileIndex.length;++o){f=e.FileIndex[o];if(!f.content)continue;c=f.content.length;if(c<4096)continue;f.start=s;l(c+511>>9)}l(a[6]+7>>3);while(n.l&511)n._W(-4,W.ENDOFCHAIN);s=i=0;for(o=0;o<e.FileIndex.length;++o){f=e.FileIndex[o];if(!f.content)continue;c=f.content.length;if(!c||c>=4096)continue;f.start=s;l(c+63>>6)}while(n.l&511)n._W(-4,W.ENDOFCHAIN);for(i=0;i<a[4]<<2;++i){var u=e.FullPaths[i];if(!u||u.length===0){for(o=0;o<17;++o)n._W(4,0);for(o=0;o<3;++o)n._W(4,-1);for(o=0;o<12;++o)n._W(4,0);continue}f=e.FileIndex[i];if(i===0)f.start=f.size?f.start-1:R;var h=i===0&&t.root||f.name;if(h.length>31){console.error(\"Name \"+h+\" will be truncated to \"+h.slice(0,31));h=h.slice(0,31)}c=2*(h.length+1);n._W(64,h,\"utf16le\");n._W(2,c);n._W(1,f.type);n._W(1,f.color);n._W(-4,f.L);n._W(-4,f.R);n._W(-4,f.C);if(!f.clsid)for(o=0;o<4;++o)n._W(4,0);else n._W(16,f.clsid,\"hex\");n._W(4,f.state||0);n._W(4,0);n._W(4,0);n._W(4,0);n._W(4,0);n._W(4,f.start);n._W(4,f.size);n._W(4,0)}for(i=1;i<e.FileIndex.length;++i){f=e.FileIndex[i];if(f.size>=4096){n.l=f.start+1<<9;if(_&&Buffer.isBuffer(f.content)){f.content.copy(n,n.l,0,f.size);n.l+=f.size+511&-512}else{for(o=0;o<f.size;++o)n._W(1,f.content[o]);for(;o&511;++o)n._W(1,0)}}}for(i=1;i<e.FileIndex.length;++i){f=e.FileIndex[i];if(f.size>0&&f.size<4096){if(_&&Buffer.isBuffer(f.content)){f.content.copy(n,n.l,0,f.size);n.l+=f.size+63&-64}else{for(o=0;o<f.size;++o)n._W(1,f.content[o]);for(;o&63;++o)n._W(1,0)}}}if(_){n.l=n.length}else{while(n.l<n.length)n._W(1,0)}return n}function M(e,r){var t=e.FullPaths.map(function(e){return e.toUpperCase()});var a=t.map(function(e){var r=e.split(\"/\");return r[r.length-(e.slice(-1)==\"/\"?2:1)]});var n=false;if(r.charCodeAt(0)===47){n=true;r=t[0].slice(0,-1)+r}else n=r.indexOf(\"/\")!==-1;var i=r.toUpperCase();var s=n===true?t.indexOf(i):a.indexOf(i);if(s!==-1)return e.FileIndex[s];var l=!i.match(U);i=i.replace(L,\"\");if(l)i=i.replace(U,\"!\");for(s=0;s<t.length;++s){if((l?t[s].replace(U,\"!\"):t[s]).replace(L,\"\")==i)return e.FileIndex[s];if((l?a[s].replace(U,\"!\"):a[s]).replace(L,\"\")==i)return e.FileIndex[s]}return null}var I=64;var R=-2;var B=\"d0cf11e0a1b11ae1\";var z=[208,207,17,224,161,177,26,225];var $=\"00000000000000000000000000000000\";var W={MAXREGSECT:-6,DIFSECT:-4,FATSECT:-3,ENDOFCHAIN:R,FREESECT:-1,HEADER_SIGNATURE:B,HEADER_MINOR_VERSION:\"3e00\",MAXREGSID:-6,NOSTREAM:-1,HEADER_CLSID:$,EntryTypes:[\"unknown\",\"storage\",\"stream\",\"lockbytes\",\"property\",\"root\"]};function j(e,r,t){o();var a=N(e,t);l.writeFileSync(r,a)}function H(e){var r=new Array(e.length);for(var t=0;t<e.length;++t)r[t]=String.fromCharCode(e[t]);return r.join(\"\")}function V(e,r){var t=N(e,r);switch(r&&r.type||\"buffer\"){case\"file\":o();l.writeFileSync(r.filename,t);return t;case\"binary\":return typeof t==\"string\"?t:H(t);case\"base64\":return y(typeof t==\"string\"?t:H(t));case\"buffer\":if(_)return Buffer.isBuffer(t)?t:A(t);case\"array\":return typeof t==\"string\"?D(t):t;}return t}var X;function G(e){try{var r=e.InflateRaw;var t=new r;t._processChunk(new Uint8Array([3,0]),t._finishFlushFlag);if(t.bytesRead)X=e;else throw new Error(\"zlib does not expose bytesRead\")}catch(a){console.error(\"cannot use native zlib: \"+(a.message||a))}}function Y(e,r){if(!X)return Fe(e,r);var t=X.InflateRaw;var a=new t;var n=a._processChunk(e.slice(e.l),a._finishFlushFlag);e.l+=a.bytesRead;return n}function J(e){return X?X.deflateRawSync(e):ye(e)}var Z=[16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];var K=[3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];var q=[1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];function Q(e){var r=(e<<1|e<<11)&139536|(e<<5|e<<15)&558144;return(r>>16|r>>8|r)&255}var ee=typeof Uint8Array!==\"undefined\";var re=ee?new Uint8Array(1<<8):[];for(var te=0;te<1<<8;++te)re[te]=Q(te);function ae(e,r){var t=re[e&255];if(r<=8)return t>>>8-r;t=t<<8|re[e>>8&255];if(r<=16)return t>>>16-r;t=t<<8|re[e>>16&255];return t>>>24-r}function ne(e,r){var t=r&7,a=r>>>3;return(e[a]|(t<=6?0:e[a+1]<<8))>>>t&3}function ie(e,r){var t=r&7,a=r>>>3;return(e[a]|(t<=5?0:e[a+1]<<8))>>>t&7}function se(e,r){var t=r&7,a=r>>>3;return(e[a]|(t<=4?0:e[a+1]<<8))>>>t&15}function le(e,r){var t=r&7,a=r>>>3;return(e[a]|(t<=3?0:e[a+1]<<8))>>>t&31}function oe(e,r){var t=r&7,a=r>>>3;return(e[a]|(t<=1?0:e[a+1]<<8))>>>t&127}function ce(e,r,t){var a=r&7,n=r>>>3,i=(1<<t)-1;var s=e[n]>>>a;if(t<8-a)return s&i;s|=e[n+1]<<8-a;if(t<16-a)return s&i;s|=e[n+2]<<16-a;if(t<24-a)return s&i;s|=e[n+3]<<24-a;return s&i}function fe(e,r,t){var a=r&7,n=r>>>3;if(a<=5)e[n]|=(t&7)<<a;else{e[n]|=t<<a&255;e[n+1]=(t&7)>>8-a}return r+3}function ue(e,r,t){var a=r&7,n=r>>>3;t=(t&1)<<a;e[n]|=t;return r+1}function he(e,r,t){var a=r&7,n=r>>>3;t<<=a;e[n]|=t&255;t>>>=8;e[n+1]=t;return r+8}function de(e,r,t){var a=r&7,n=r>>>3;t<<=a;e[n]|=t&255;t>>>=8;e[n+1]=t&255;e[n+2]=t>>>8;return r+16}function pe(e,r){var t=e.length,a=2*t>r?2*t:r+5,n=0;if(t>=r)return e;if(_){var i=F(a);if(e.copy)e.copy(i);else for(;n<e.length;++n)i[n]=e[n];return i}else if(ee){var s=new Uint8Array(a);if(s.set)s.set(e);else for(;n<t;++n)s[n]=e[n];return s}e.length=a;return e}function me(e){var r=new Array(e);for(var t=0;t<e;++t)r[t]=0;return r}function ve(e,r,t){var a=1,n=0,i=0,s=0,l=0,o=e.length;var c=ee?new Uint16Array(32):me(32);for(i=0;i<32;++i)c[i]=0;for(i=o;i<t;++i)e[i]=0;o=e.length;var f=ee?new Uint16Array(o):me(o);for(i=0;i<o;++i){c[n=e[i]]++;if(a<n)a=n;f[i]=0}c[0]=0;for(i=1;i<=a;++i)c[i+16]=l=l+c[i-1]<<1;for(i=0;i<o;++i){l=e[i];if(l!=0)f[i]=c[l+16]++}var u=0;for(i=0;i<o;++i){u=e[i];if(u!=0){l=ae(f[i],a)>>a-u;for(s=(1<<a+4-u)-1;s>=0;--s)r[l|s<<u]=u&15|i<<4}}return a}var ge=ee?new Uint16Array(512):me(512);var be=ee?new Uint16Array(32):me(32);if(!ee){for(var we=0;we<512;++we)ge[we]=0;for(we=0;we<32;++we)be[we]=0}(function(){var e=[];var r=0;for(;r<32;r++)e.push(5);ve(e,be,32);var t=[];r=0;for(;r<=143;r++)t.push(8);for(;r<=255;r++)t.push(9);for(;r<=279;r++)t.push(7);for(;r<=287;r++)t.push(8);ve(t,ge,288)})();var ke=function Ge(){var e=ee?new Uint8Array(32768):[];var r=0,t=0;for(;r<q.length-1;++r){for(;t<q[r+1];++t)e[t]=r}for(;t<32768;++t)e[t]=29;var a=ee?new Uint8Array(259):[];for(r=0,t=0;r<K.length-1;++r){for(;t<K[r+1];++t)a[t]=r}function n(e,r){var t=0;while(t<e.length){var a=Math.min(65535,e.length-t);var n=t+a==e.length;r._W(1,+n);r._W(2,a);r._W(2,~a&65535);while(a-- >0)r[r.l++]=e[t++]}return r.l}function i(r,t){var n=0;var i=0;var s=ee?new Uint16Array(32768):[];while(i<r.length){var l=Math.min(65535,r.length-i);if(l<10){n=fe(t,n,+!!(i+l==r.length));if(n&7)n+=8-(n&7);t.l=n/8|0;t._W(2,l);t._W(2,~l&65535);while(l-- >0)t[t.l++]=r[i++];n=t.l*8;continue}n=fe(t,n,+!!(i+l==r.length)+2);var o=0;while(l-- >0){var c=r[i];o=(o<<5^c)&32767;var f=-1,u=0;if(f=s[o]){f|=i&~32767;if(f>i)f-=32768;if(f<i)while(r[f+u]==r[i+u]&&u<250)++u}if(u>2){c=a[u];if(c<=22)n=he(t,n,re[c+1]>>1)-1;else{he(t,n,3);n+=5;he(t,n,re[c-23]>>5);n+=3}var h=c<8?0:c-4>>2;if(h>0){de(t,n,u-K[c]);n+=h}c=e[i-f];n=he(t,n,re[c]>>3);n-=3;var d=c<4?0:c-2>>1;if(d>0){de(t,n,i-f-q[c]);n+=d}for(var p=0;p<u;++p){s[o]=i&32767;o=(o<<5^r[i])&32767;++i}l-=u-1}else{if(c<=143)c=c+48;else n=ue(t,n,1);n=he(t,n,re[c]);s[o]=i&32767;++i}}n=he(t,n,0)-1}t.l=(n+7)/8|0;return t.l}return function s(e,r){if(e.length<8)return n(e,r);return i(e,r)}}();function ye(e){var r=Oa(50+Math.floor(e.length*1.1));var t=ke(e,r);return r.slice(0,t)}var xe=ee?new Uint16Array(32768):me(32768);var Ce=ee?new Uint16Array(32768):me(32768);var Se=ee?new Uint16Array(128):me(128);var _e=1,Ae=1;function Te(e,r){var t=le(e,r)+257;r+=5;var a=le(e,r)+1;r+=5;var n=se(e,r)+4;r+=4;var i=0;var s=ee?new Uint8Array(19):me(19);var l=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];var o=1;var c=ee?new Uint8Array(8):me(8);var f=ee?new Uint8Array(8):me(8);var u=s.length;for(var h=0;h<n;++h){s[Z[h]]=i=ie(e,r);if(o<i)o=i;c[i]++;r+=3}var d=0;c[0]=0;for(h=1;h<=o;++h)f[h]=d=d+c[h-1]<<1;for(h=0;h<u;++h)if((d=s[h])!=0)l[h]=f[d]++;var p=0;for(h=0;h<u;++h){p=s[h];if(p!=0){d=re[l[h]]>>8-p;for(var m=(1<<7-p)-1;m>=0;--m)Se[d|m<<p]=p&7|h<<3}}var v=[];o=1;for(;v.length<t+a;){d=Se[oe(e,r)];r+=d&7;switch(d>>>=3){case 16:i=3+ne(e,r);r+=2;d=v[v.length-1];while(i-- >0)v.push(d);break;case 17:i=3+ie(e,r);r+=3;while(i-- >0)v.push(0);break;case 18:i=11+oe(e,r);r+=7;while(i-- >0)v.push(0);break;default:v.push(d);if(o<d)o=d;break;}}var g=v.slice(0,t),b=v.slice(t);for(h=t;h<286;++h)g[h]=0;for(h=a;h<30;++h)b[h]=0;_e=ve(g,xe,286);Ae=ve(b,Ce,30);return r}function Ee(e,r){if(e[0]==3&&!(e[1]&3)){return[E(r),2]}var t=0;var a=0;var n=F(r?r:1<<18);var i=0;var s=n.length>>>0;var l=0,o=0;while((a&1)==0){a=ie(e,t);t+=3;if(a>>>1==0){if(t&7)t+=8-(t&7);var c=e[t>>>3]|e[(t>>>3)+1]<<8;t+=32;if(c>0){if(!r&&s<i+c){n=pe(n,i+c);s=n.length}while(c-- >0){n[i++]=e[t>>>3];t+=8}}continue}else if(a>>1==1){l=9;o=5}else{t=Te(e,t);l=_e;o=Ae}for(;;){if(!r&&s<i+32767){n=pe(n,i+32767);s=n.length}var f=ce(e,t,l);var u=a>>>1==1?ge[f]:xe[f];t+=u&15;u>>>=4;if((u>>>8&255)===0)n[i++]=u;else if(u==256)break;else{u-=257;var h=u<8?0:u-4>>2;if(h>5)h=0;var d=i+K[u];if(h>0){d+=ce(e,t,h);t+=h}f=ce(e,t,o);u=a>>>1==1?be[f]:Ce[f];t+=u&15;u>>>=4;var p=u<4?0:u-2>>1;var m=q[u];if(p>0){m+=ce(e,t,p);t+=p}if(!r&&s<d){n=pe(n,d+100);s=n.length}while(i<d){n[i]=n[i-m];++i}}}}if(r)return[n,t+7>>>3];return[n.slice(0,i),t+7>>>3]}function Fe(e,r){var t=e.slice(e.l||0);var a=Ee(t,r);e.l+=a[1];return a[0]}function De(e,r){if(e){if(typeof console!==\"undefined\")console.error(r)}else throw new Error(r)}function Oe(e,r){var t=e;Fa(t,0);var a=[],n=[];var i={FileIndex:a,FullPaths:n};C(i,{root:r.root});var l=t.length-4;while((t[l]!=80||t[l+1]!=75||t[l+2]!=5||t[l+3]!=6)&&l>=0)--l;t.l=l+4;t.l+=4;var o=t._R(2);t.l+=6;var c=t._R(4);t.l=c;for(l=0;l<o;++l){t.l+=20;var f=t._R(4);var u=t._R(4);var h=t._R(2);var d=t._R(2);var p=t._R(2);t.l+=8;var m=t._R(4);var v=s(t.slice(t.l+h,t.l+h+d));t.l+=h+d+p;var g=t.l;t.l=m+4;if(v&&v[1]){if((v[1]||{}).usz)u=v[1].usz;if((v[1]||{}).csz)f=v[1].csz}Ne(t,f,u,i,v);t.l=g}return i}function Ne(e,r,t,a,n){e.l+=2;var l=e._R(2);var o=e._R(2);var c=i(e);if(l&8257)throw new Error(\"Unsupported ZIP encryption\");var f=e._R(4);var u=e._R(4);var h=e._R(4);var d=e._R(2);var p=e._R(2);var m=\"\";for(var v=0;v<d;++v)m+=String.fromCharCode(e[e.l++]);if(p){var g=s(e.slice(e.l,e.l+p));if((g[21589]||{}).mt)c=g[21589].mt;if((g[1]||{}).usz)h=g[1].usz;if((g[1]||{}).csz)u=g[1].csz;if(n){if((n[21589]||{}).mt)c=n[21589].mt;if((n[1]||{}).usz)h=n[1].usz;if((n[1]||{}).csz)u=n[1].csz}}e.l+=p;var b=e.slice(e.l,e.l+u);switch(o){case 8:b=Y(e,h);break;case 0:e.l+=u;break;default:throw new Error(\"Unsupported ZIP Compression method \"+o);}var w=false;if(l&8){f=e._R(4);if(f==134695760){f=e._R(4);w=true}u=e._R(4);h=e._R(4)}if(u!=r)De(w,\"Bad compressed size: \"+r+\" != \"+u);if(h!=t)De(w,\"Bad uncompressed size: \"+t+\" != \"+h);je(a,m,b,{unsafe:true,mt:c})}function Me(e,r){var t=r||{};var a=[],i=[];var s=Oa(1);var l=t.compression?8:0,o=0;var c=false;if(c)o|=8;var f=0,u=0;var h=0,d=0;var p=e.FullPaths[0],m=p,v=e.FileIndex[0];var g=[];var b=0;for(f=1;f<e.FullPaths.length;++f){m=e.FullPaths[f].slice(p.length);v=e.FileIndex[f];if(!v.size||!v.content||Array.isArray(v.content)&&v.content.length==0||m==\"\u0001Sh33tJ5\")continue;var w=h;var k=Oa(m.length);for(u=0;u<m.length;++u)k._W(1,m.charCodeAt(u)&127);k=k.slice(0,k.l);g[d]=typeof v.content==\"string\"?qe.bstr(v.content,0):qe.buf(v.content,0);var y=typeof v.content==\"string\"?D(v.content):v.content;if(l==8)y=J(y);s=Oa(30);s._W(4,67324752);s._W(2,20);s._W(2,o);s._W(2,l);if(v.mt)n(s,v.mt);else s._W(4,0);s._W(-4,o&8?0:g[d]);s._W(4,o&8?0:y.length);s._W(4,o&8?0:v.content.length);s._W(2,k.length);s._W(2,0);h+=s.length;a.push(s);h+=k.length;a.push(k);h+=y.length;a.push(y);if(o&8){s=Oa(12);s._W(-4,g[d]);s._W(4,y.length);s._W(4,v.content.length);h+=s.l;a.push(s)}s=Oa(46);s._W(4,33639248);s._W(2,0);s._W(2,20);s._W(2,o);s._W(2,l);s._W(4,0);s._W(-4,g[d]);s._W(4,y.length);s._W(4,v.content.length);s._W(2,k.length);s._W(2,0);s._W(2,0);s._W(2,0);s._W(2,0);s._W(4,0);s._W(4,w);b+=s.l;i.push(s);b+=k.length;i.push(k);++d}s=Oa(22);s._W(4,101010256);s._W(2,0);s._W(2,0);s._W(2,d);s._W(2,d);s._W(4,b);s._W(4,h);s._W(2,0);return P([P(a),P(i),s])}var Ie={htm:\"text/html\",xml:\"text/xml\",gif:\"image/gif\",jpg:\"image/jpeg\",png:\"image/png\",mso:\"application/x-mso\",thmx:\"application/vnd.ms-officetheme\",sh33tj5:\"application/octet-stream\"};function Pe(e,r){if(e.ctype)return e.ctype;var t=e.name||\"\",a=t.match(/\\.([^\\.]+)$/);if(a&&Ie[a[1]])return Ie[a[1]];if(r){a=(t=r).match(/[\\.\\\\]([^\\.\\\\])+$/);if(a&&Ie[a[1]])return Ie[a[1]]}return\"application/octet-stream\"}function Re(e){var r=y(e);var t=[];for(var a=0;a<r.length;a+=76)t.push(r.slice(a,a+76));return t.join(\"\\r\\n\")+\"\\r\\n\"}function Le(e){var r=e.replace(/[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7E-\\xFF=]/g,function(e){var r=e.charCodeAt(0).toString(16).toUpperCase();return\"=\"+(r.length==1?\"0\"+r:r)});r=r.replace(/ $/gm,\"=20\").replace(/\\t$/gm,\"=09\");if(r.charAt(0)==\"\\n\")r=\"=0D\"+r.slice(1);r=r.replace(/\\r(?!\\n)/gm,\"=0D\").replace(/\\n\\n/gm,\"\\n=0A\").replace(/([^\\r\\n])\\n/gm,\"$1=0A\");var t=[],a=r.split(\"\\r\\n\");for(var n=0;n<a.length;++n){var i=a[n];if(i.length==0){t.push(\"\");continue}for(var s=0;s<i.length;){var l=76;var o=i.slice(s,s+l);if(o.charAt(l-1)==\"=\")l--;else if(o.charAt(l-2)==\"=\")l-=2;else if(o.charAt(l-3)==\"=\")l-=3;o=i.slice(s,s+l);s+=l;if(s<i.length)o+=\"=\";t.push(o)}}return t.join(\"\\r\\n\")}function Ue(e){var r=[];for(var t=0;t<e.length;++t){var a=e[t];while(t<=e.length&&a.charAt(a.length-1)==\"=\")a=a.slice(0,a.length-1)+e[++t];r.push(a)}for(var n=0;n<r.length;++n)r[n]=r[n].replace(/[=][0-9A-Fa-f]{2}/g,function(e){return String.fromCharCode(parseInt(e.slice(1),16))});return D(r.join(\"\\r\\n\"))}function Be(e,r,t){var a=\"\",n=\"\",i=\"\",s;var l=0;for(;l<10;++l){var o=r[l];if(!o||o.match(/^\\s*$/))break;var c=o.match(/^([^:]*?):\\s*([^\\s].*)$/);if(c)switch(c[1].toLowerCase()){case\"content-location\":a=c[2].trim();break;case\"content-type\":i=c[2].trim();break;case\"content-transfer-encoding\":n=c[2].trim();break;}}++l;switch(n.toLowerCase()){case\"base64\":s=D(S(r.slice(l).join(\"\")));break;case\"quoted-printable\":s=Ue(r.slice(l));break;default:throw new Error(\"Unsupported Content-Transfer-Encoding \"+n);}var f=je(e,a.slice(t.length),s,{unsafe:true});if(i)f.ctype=i}function ze(e,r){if(H(e.slice(0,13)).toLowerCase()!=\"mime-version:\")throw new Error(\"Unsupported MAD header\");var t=r&&r.root||\"\";var a=(_&&Buffer.isBuffer(e)?e.toString(\"binary\"):H(e)).split(\"\\r\\n\");var n=0,i=\"\";for(n=0;n<a.length;++n){i=a[n];if(!/^Content-Location:/i.test(i))continue;i=i.slice(i.indexOf(\"file\"));if(!t)t=i.slice(0,i.lastIndexOf(\"/\")+1);if(i.slice(0,t.length)==t)continue;while(t.length>0){t=t.slice(0,t.length-1);t=t.slice(0,t.lastIndexOf(\"/\")+1);if(i.slice(0,t.length)==t)break}}var s=(a[1]||\"\").match(/boundary=\"(.*?)\"/);if(!s)throw new Error(\"MAD cannot find boundary\");var l=\"--\"+(s[1]||\"\");var o=[],c=[];var f={FileIndex:o,FullPaths:c};C(f);var u,h=0;for(n=0;n<a.length;++n){var d=a[n];if(d!==l&&d!==l+\"--\")continue;if(h++)Be(f,a.slice(u,n),t);u=n}return f}function $e(e,r){var t=r||{};var a=t.boundary||\"SheetJS\";a=\"------=\"+a;var n=[\"MIME-Version: 1.0\",'Content-Type: multipart/related; boundary=\"'+a.slice(2)+'\"',\"\",\"\",\"\"];var i=e.FullPaths[0],s=i,l=e.FileIndex[0];for(var o=1;o<e.FullPaths.length;++o){s=e.FullPaths[o].slice(i.length);l=e.FileIndex[o];if(!l.size||!l.content||s==\"\u0001Sh33tJ5\")continue;s=s.replace(/[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7E-\\xFF]/g,function(e){return\"_x\"+e.charCodeAt(0).toString(16)+\"_\"}).replace(/[\\u0080-\\uFFFF]/g,function(e){return\"_u\"+e.charCodeAt(0).toString(16)+\"_\"});var c=l.content;var f=_&&Buffer.isBuffer(c)?c.toString(\"binary\"):H(c);var u=0,h=Math.min(1024,f.length),d=0;for(var p=0;p<=h;++p)if((d=f.charCodeAt(p))>=32&&d<128)++u;var m=u>=h*4/5;n.push(a);n.push(\"Content-Location: \"+(t.root||\"file:///C:/SheetJS/\")+s);n.push(\"Content-Transfer-Encoding: \"+(m?\"quoted-printable\":\"base64\"));n.push(\"Content-Type: \"+Pe(l,s));n.push(\"\");n.push(m?Le(f):Re(f))}n.push(a+\"--\\r\\n\");return n.join(\"\\r\\n\")}function We(e){var r={};C(r,e);return r}function je(e,r,t,n){var i=n&&n.unsafe;if(!i)C(e);var s=!i&&Qe.find(e,r);if(!s){var l=e.FullPaths[0];if(r.slice(0,l.length)==l)l=r;else{if(l.slice(-1)!=\"/\")l+=\"/\";l=(l+r).replace(\"//\",\"/\")}s={name:a(r),type:2};e.FileIndex.push(s);e.FullPaths.push(l);if(!i)Qe.utils.cfb_gc(e)}s.content=t;s.size=t?t.length:0;if(n){if(n.CLSID)s.clsid=n.CLSID;if(n.mt)s.mt=n.mt;if(n.ct)s.ct=n.ct}return s}function He(e,r){C(e);var t=Qe.find(e,r);if(t)for(var a=0;a<e.FileIndex.length;++a)if(e.FileIndex[a]==t){e.FileIndex.splice(a,1);e.FullPaths.splice(a,1);return true}return false}function Ve(e,r,t){C(e);var n=Qe.find(e,r);if(n)for(var i=0;i<e.FileIndex.length;++i)if(e.FileIndex[i]==n){e.FileIndex[i].name=a(t);e.FullPaths[i]=t;return true}return false}function Xe(e){O(e,true)}e.find=M;e.read=x;e.parse=c;e.write=V;e.writeFile=j;e.utils={cfb_new:We,cfb_add:je,cfb_del:He,cfb_mov:Ve,cfb_gc:Xe,ReadShift:Ca,CheckField:Ea,prep_blob:Fa,bconcat:P,use_zlib:G,_deflateRaw:ye,_inflateRaw:Fe,consts:W};return e}();var er;function rr(e){er=e}function tr(e){if(typeof e===\"string\")return O(e);if(Array.isArray(e))return M(e);return e}function ar(e,r,t){if(typeof er!==\"undefined\"&&er.writeFileSync)return t?er.writeFileSync(e,r,t):er.writeFileSync(e,r);if(typeof Deno!==\"undefined\"){if(t&&typeof r==\"string\")switch(t){case\"utf8\":r=new TextEncoder(t).encode(r);break;case\"binary\":r=O(r);break;default:throw new Error(\"Unsupported encoding \"+t);}return Deno.writeFileSync(e,r)}var a=t==\"utf8\"?Ot(r):r;if(typeof IE_SaveFile!==\"undefined\")return IE_SaveFile(a,e);if(typeof Blob!==\"undefined\"){var n=new Blob([tr(a)],{type:\"application/octet-stream\"});if(typeof navigator!==\"undefined\"&&navigator.msSaveBlob)return navigator.msSaveBlob(n,e);if(typeof saveAs!==\"undefined\")return saveAs(n,e);if(typeof URL!==\"undefined\"&&typeof document!==\"undefined\"&&document.createElement&&URL.createObjectURL){var i=URL.createObjectURL(n);if(typeof chrome===\"object\"&&typeof(chrome.downloads||{}).download==\"function\"){if(URL.revokeObjectURL&&typeof setTimeout!==\"undefined\")setTimeout(function(){URL.revokeObjectURL(i)},6e4);return chrome.downloads.download({url:i,filename:e,saveAs:true})}var s=document.createElement(\"a\");if(s.download!=null){s.download=e;s.href=i;document.body.appendChild(s);s.click();document.body.removeChild(s);if(URL.revokeObjectURL&&typeof setTimeout!==\"undefined\")setTimeout(function(){URL.revokeObjectURL(i)},6e4);return i}}else if(typeof URL!==\"undefined\"&&!URL.createObjectURL&&typeof chrome===\"object\"){var l=\"data:application/octet-stream;base64,\"+C(new Uint8Array(tr(a)));return chrome.downloads.download({url:l,filename:e,saveAs:true})}}if(typeof $!==\"undefined\"&&typeof File!==\"undefined\"&&typeof Folder!==\"undefined\")try{var o=File(e);o.open(\"w\");o.encoding=\"binary\";if(Array.isArray(r))r=N(r);\no.write(r);o.close();return r}catch(c){if(!c.message||c.message.indexOf(\"onstruct\")==-1)throw c}throw new Error(\"cannot save file \"+e)}function nr(e){if(typeof er!==\"undefined\")return er.readFileSync(e);if(typeof Deno!==\"undefined\")return Deno.readFileSync(e);if(typeof $!==\"undefined\"&&typeof File!==\"undefined\"&&typeof Folder!==\"undefined\")try{var r=File(e);r.open(\"r\");r.encoding=\"binary\";var t=r.read();r.close();return t}catch(a){if(!a.message||a.message.indexOf(\"onstruct\")==-1)throw a}throw new Error(\"Cannot access file \"+e)}function ir(e){var r=Object.keys(e),t=[];for(var a=0;a<r.length;++a)if(Object.prototype.hasOwnProperty.call(e,r[a]))t.push(r[a]);return t}function sr(e,r){var t=[],a=ir(e);for(var n=0;n!==a.length;++n)if(t[e[a[n]][r]]==null)t[e[a[n]][r]]=a[n];return t}function lr(e){var r=[],t=ir(e);for(var a=0;a!==t.length;++a)r[e[t[a]]]=t[a];return r}function or(e){var r=[],t=ir(e);for(var a=0;a!==t.length;++a)r[e[t[a]]]=parseInt(t[a],10);return r}function cr(e){var r=[],t=ir(e);for(var a=0;a!==t.length;++a){if(r[e[t[a]]]==null)r[e[t[a]]]=[];r[e[t[a]]].push(t[a])}return r}var fr=Date.UTC(1899,11,30,0,0,0);var ur=Date.UTC(1899,11,31,0,0,0);var hr=Date.UTC(1904,0,1,0,0,0);function dr(e,r){var t=e.getTime();var a=(t-fr)/(24*60*60*1e3);if(r){a-=1462;return a<-1402?a-1:a}return a<60?a-1:a}function pr(e){if(e>=60&&e<61)return e;var r=new Date;r.setTime((e>60?e:e+1)*24*60*60*1e3+fr);return r}function mr(e){var r=0,t=0,a=false;var n=e.match(/P([0-9\\.]+Y)?([0-9\\.]+M)?([0-9\\.]+D)?T([0-9\\.]+H)?([0-9\\.]+M)?([0-9\\.]+S)?/);if(!n)throw new Error(\"|\"+e+\"| is not an ISO8601 Duration\");for(var i=1;i!=n.length;++i){if(!n[i])continue;t=1;if(i>3)a=true;switch(n[i].slice(n[i].length-1)){case\"Y\":throw new Error(\"Unsupported ISO Duration Field: \"+n[i].slice(n[i].length-1));case\"D\":t*=24;case\"H\":t*=60;case\"M\":if(!a)throw new Error(\"Unsupported ISO Duration Field: M\");else t*=60;case\"S\":break;}r+=t*parseInt(n[i],10)}return r}var vr=/^(\\d+):(\\d+)(:\\d+)?(\\.\\d+)?$/;var gr=/^(\\d+)-(\\d+)-(\\d+)$/;var br=/^(\\d+)-(\\d+)-(\\d+)[T ](\\d+):(\\d+)(:\\d+)?(\\.\\d+)?$/;function wr(e,r){if(e instanceof Date)return e;var t=e.match(vr);if(t)return new Date((r?hr:ur)+((parseInt(t[1],10)*60+parseInt(t[2],10))*60+(t[3]?parseInt(t[3].slice(1),10):0))*1e3+(t[4]?parseInt((t[4]+\"000\").slice(1,4),10):0));t=e.match(gr);if(t)return new Date(Date.UTC(+t[1],+t[2]-1,+t[3],0,0,0,0));t=e.match(br);if(t)return new Date(Date.UTC(+t[1],+t[2]-1,+t[3],+t[4],+t[5],t[6]&&parseInt(t[6].slice(1),10)||0,t[7]&&parseInt((t[7]+\"0000\").slice(1,4),10)||0));var a=new Date(e);return a}function kr(e,r){if(_&&Buffer.isBuffer(e)){if(r&&T){if(e[0]==255&&e[1]==254)return Ot(e.slice(2).toString(\"utf16le\"));if(e[1]==254&&e[2]==255)return Ot(d(e.slice(2).toString(\"binary\")))}return e.toString(\"binary\")}if(typeof TextDecoder!==\"undefined\")try{if(r){if(e[0]==255&&e[1]==254)return Ot(new TextDecoder(\"utf-16le\").decode(e.slice(2)));if(e[0]==254&&e[1]==255)return Ot(new TextDecoder(\"utf-16be\").decode(e.slice(2)))}var t={\"€\":\"\",\"‚\":\"\",\"ƒ\":\"\",\"„\":\"\",\"…\":\"\",\"†\":\"\",\"‡\":\"\",\"ˆ\":\"\",\"‰\":\"\",\"Š\":\"\",\"‹\":\"\",\"Œ\":\"\",\"Ž\":\"\",\"‘\":\"\",\"’\":\"\",\"“\":\"\",\"”\":\"\",\"•\":\"\",\"–\":\"\",\"—\":\"\",\"˜\":\"\",\"™\":\"\",\"š\":\"\",\"›\":\"\",\"œ\":\"\",\"ž\":\"\",\"Ÿ\":\"\"};if(Array.isArray(e))e=new Uint8Array(e);return new TextDecoder(\"latin1\").decode(e).replace(/[€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g,function(e){return t[e]||e})}catch(a){}var n=[],i=0;try{for(i=0;i<e.length-65536;i+=65536)n.push(String.fromCharCode.apply(0,e.slice(i,i+65536)));n.push(String.fromCharCode.apply(0,e.slice(i)))}catch(a){try{for(;i<e.length-16384;i+=16384)n.push(String.fromCharCode.apply(0,e.slice(i,i+16384)));n.push(String.fromCharCode.apply(0,e.slice(i)))}catch(a){for(;i!=e.length;++i)n.push(String.fromCharCode(e[i]))}}return n.join(\"\")}function yr(e){if(typeof JSON!=\"undefined\"&&!Array.isArray(e))return JSON.parse(JSON.stringify(e));if(typeof e!=\"object\"||e==null)return e;if(e instanceof Date)return new Date(e.getTime());var r={};for(var t in e)if(Object.prototype.hasOwnProperty.call(e,t))r[t]=yr(e[t]);return r}function xr(e,r){var t=\"\";while(t.length<r)t+=e;return t}function Cr(e){var r=Number(e);if(!isNaN(r))return isFinite(r)?r:NaN;if(!/\\d/.test(e))return r;var t=1;var a=e.replace(/([\\d]),([\\d])/g,\"$1$2\").replace(/[$]/g,\"\").replace(/[%]/g,function(){t*=100;return\"\"});if(!isNaN(r=Number(a)))return r/t;a=a.replace(/[(]([^()]*)[)]/,function(e,r){t=-t;return r});if(!isNaN(r=Number(a)))return r/t;return r}var Sr=/^(0?\\d|1[0-2])(?:|:([0-5]?\\d)(?:|(\\.\\d+)(?:|:([0-5]?\\d))|:([0-5]?\\d)(|\\.\\d+)))\\s+([ap])m?$/;var _r=/^([01]?\\d|2[0-3])(?:|:([0-5]?\\d)(?:|(\\.\\d+)(?:|:([0-5]?\\d))|:([0-5]?\\d)(|\\.\\d+)))$/;var Ar=/^(\\d+)-(\\d+)-(\\d+)[T ](\\d+):(\\d+)(:\\d+)(\\.\\d+)?[Z]?$/;var Tr=new Date(\"6/9/69 00:00 UTC\").valueOf()==-177984e5;function Er(e){if(!e[2])return new Date(Date.UTC(1899,11,31,+e[1]%12+(e[7]==\"p\"?12:0),0,0,0));if(e[3]){if(e[4])return new Date(Date.UTC(1899,11,31,+e[1]%12+(e[7]==\"p\"?12:0),+e[2],+e[4],parseFloat(e[3])*1e3));else return new Date(Date.UTC(1899,11,31,e[7]==\"p\"?12:0,+e[1],+e[2],parseFloat(e[3])*1e3))}else if(e[5])return new Date(Date.UTC(1899,11,31,+e[1]%12+(e[7]==\"p\"?12:0),+e[2],+e[5],e[6]?parseFloat(e[6])*1e3:0));else return new Date(Date.UTC(1899,11,31,+e[1]%12+(e[7]==\"p\"?12:0),+e[2],0,0))}function Fr(e){if(!e[2])return new Date(Date.UTC(1899,11,31,+e[1],0,0,0));if(e[3]){if(e[4])return new Date(Date.UTC(1899,11,31,+e[1],+e[2],+e[4],parseFloat(e[3])*1e3));else return new Date(Date.UTC(1899,11,31,0,+e[1],+e[2],parseFloat(e[3])*1e3))}else if(e[5])return new Date(Date.UTC(1899,11,31,+e[1],+e[2],+e[5],e[6]?parseFloat(e[6])*1e3:0));else return new Date(Date.UTC(1899,11,31,+e[1],+e[2],0,0))}var Dr=[\"january\",\"february\",\"march\",\"april\",\"may\",\"june\",\"july\",\"august\",\"september\",\"october\",\"november\",\"december\"];function Or(e){if(Ar.test(e))return e.indexOf(\"Z\")==-1?Ir(new Date(e)):new Date(e);var r=e.toLowerCase();var t=r.replace(/\\s+/g,\" \").trim();var a=t.match(Sr);if(a)return Er(a);a=t.match(_r);if(a)return Fr(a);a=t.match(br);if(a)return new Date(Date.UTC(+a[1],+a[2]-1,+a[3],+a[4],+a[5],a[6]&&parseInt(a[6].slice(1),10)||0,a[7]&&parseInt((a[7]+\"0000\").slice(1,4),10)||0));var n=new Date(Tr&&e.indexOf(\"UTC\")==-1?e+\" UTC\":e),i=new Date(NaN);var s=n.getYear(),l=n.getMonth(),o=n.getDate();if(isNaN(o))return i;if(r.match(/jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/)){r=r.replace(/[^a-z]/g,\"\").replace(/([^a-z]|^)[ap]m?([^a-z]|$)/,\"\");if(r.length>3&&Dr.indexOf(r)==-1)return i}else if(r.replace(/[ap]m?/,\"\").match(/[a-z]/))return i;if(s<0||s>8099||e.match(/[^-0-9:,\\/\\\\\\ ]/))return i;return n}var Nr=function(){var e=\"abacaba\".split(/(:?b)/i).length==5;return function r(t,a,n){if(e||typeof a==\"string\")return t.split(a);var i=t.split(a),s=[i[0]];for(var l=1;l<i.length;++l){s.push(n);s.push(i[l])}return s}}();function Mr(e){return new Date(e.getUTCFullYear(),e.getUTCMonth(),e.getUTCDate(),e.getUTCHours(),e.getUTCMinutes(),e.getUTCSeconds(),e.getUTCMilliseconds())}function Ir(e){return new Date(Date.UTC(e.getFullYear(),e.getMonth(),e.getDate(),e.getHours(),e.getMinutes(),e.getSeconds(),e.getMilliseconds()))}function Pr(e){var r=e.slice(0,1024);var t=r.indexOf(\"<!DOCTYPE\");if(t==-1)return e;var a=e.match(/<[\\w]/);if(!a)return e;return e.slice(0,t)+e.slice(a.index)}function Rr(e,r,t){var a=[];var n=e.indexOf(r);while(n>-1){var i=e.indexOf(t,n+r.length);if(i==-1)break;a.push(e.slice(n,i+t.length));n=e.indexOf(r,i+t.length)}return a.length>0?a:null}function Lr(e,r,t){var a=[],n=0;var i=e.indexOf(r);if(i==-1)return e;while(i>-1){a.push(e.slice(n,i));var s=e.indexOf(t,i+r.length);if(s==-1)break;if((i=e.indexOf(r,n=s+t.length))==-1)a.push(e.slice(n))}return a.join(\"\")}var Ur={\" \":1,\"\\t\":1,\"\\r\":1,\"\\n\":1,\">\":1};function Br(e,r){var t=e.indexOf(\"<\"+r),a=r.length+1,n=e.length;while(t>=0&&t<=n-a&&!Ur[e.charAt(t+a)])t=e.indexOf(\"<\"+r,t+1);if(t===-1)return null;var i=e.indexOf(\">\",t+r.length);if(i===-1)return null;var s=\"</\"+r+\">\";var l=e.indexOf(s,i);if(l==-1)return null;return[e.slice(t,l+s.length),e.slice(i+1,l)]}var zr=function(){var e={};return function r(t,a){var n=e[a];if(!n)e[a]=n=[new RegExp(\"<(?:\\\\w+:)?\"+a+\"\\\\b[^<>]*>\",\"g\"),new RegExp(\"</(?:\\\\w+:)?\"+a+\">\",\"g\")];n[0].lastIndex=n[1].lastIndex=0;var i=n[0].exec(t);if(!i)return null;var s=i.index;var l=n[0].lastIndex;n[1].lastIndex=n[0].lastIndex;i=n[1].exec(t);if(!i)return null;var o=i.index;var c=n[1].lastIndex;return[t.slice(s,c),t.slice(l,o)]}}();var $r=function(){var e={};return function r(t,a){var n=[];var i=e[a];if(!i)e[a]=i=[new RegExp(\"<(?:\\\\w+:)?\"+a+\"\\\\b[^<>]*>\",\"g\"),new RegExp(\"</(?:\\\\w+:)?\"+a+\">\",\"g\")];i[0].lastIndex=i[1].lastIndex=0;var s;while(s=i[0].exec(t)){var l=s.index;i[1].lastIndex=i[0].lastIndex;s=i[1].exec(t);if(!s)return null;var o=i[1].lastIndex;n.push(t.slice(l,o));i[0].lastIndex=i[1].lastIndex}return n.length==0?null:n}}();var Wr=function(){var e={};return function r(t,a){var n=[];var i=e[a];if(!i)e[a]=i=[new RegExp(\"<(?:\\\\w+:)?\"+a+\"\\\\b[^<>]*>\",\"g\"),new RegExp(\"</(?:\\\\w+:)?\"+a+\">\",\"g\")];i[0].lastIndex=i[1].lastIndex=0;var s;var l=0,o=0;while(s=i[0].exec(t)){l=s.index;n.push(t.slice(o,l));o=l;i[1].lastIndex=i[0].lastIndex;s=i[1].exec(t);if(!s)return null;o=i[1].lastIndex;i[0].lastIndex=i[1].lastIndex}n.push(t.slice(o));return n.length==0?\"\":n.join(\"\")}}();var jr=function(){var e={};return function r(t,a){var n=[];var i=e[a];if(!i)e[a]=i=[new RegExp(\"<\"+a+\"\\\\b[^<>]*>\",\"ig\"),new RegExp(\"</\"+a+\">\",\"ig\")];i[0].lastIndex=i[1].lastIndex=0;var s;while(s=i[0].exec(t)){var l=s.index;i[1].lastIndex=i[0].lastIndex;s=i[1].exec(t);if(!s)return null;var o=i[1].lastIndex;n.push(t.slice(l,o));i[0].lastIndex=i[1].lastIndex}return n.length==0?null:n}}();function Hr(e){if(!e)return null;if(e.content&&e.type)return kr(e.content,true);if(e.data)return p(e.data);if(e.asNodeBuffer&&_)return p(e.asNodeBuffer().toString(\"binary\"));if(e.asBinary)return p(e.asBinary());if(e._data&&e._data.getContent)return p(kr(Array.prototype.slice.call(e._data.getContent(),0)));return null}function Vr(e){if(!e)return null;if(e.data)return f(e.data);if(e.asNodeBuffer&&_)return e.asNodeBuffer();if(e._data&&e._data.getContent){var r=e._data.getContent();if(typeof r==\"string\")return f(r);return Array.prototype.slice.call(r)}if(e.content&&e.type)return e.content;return null}function Xr(e){return e&&e.name.slice(-4)===\".bin\"?Vr(e):Hr(e)}function Gr(e,r){var t=e.FullPaths||ir(e.files);var a=r.toLowerCase().replace(/[\\/]/g,\"\\\\\"),n=a.replace(/\\\\/g,\"/\");for(var i=0;i<t.length;++i){var s=t[i].replace(/^Root Entry[\\/]/,\"\").toLowerCase();if(a==s||n==s)return e.files?e.files[t[i]]:e.FileIndex[i]}return null}function Yr(e,r){var t=Gr(e,r);if(t==null)throw new Error(\"Cannot find file \"+r+\" in zip\");return t}function Jr(e,r,t){if(!t)return Xr(Yr(e,r));if(!r)return null;try{return Jr(e,r)}catch(a){return null}}function Zr(e,r,t){if(!t)return Hr(Yr(e,r));if(!r)return null;try{return Zr(e,r)}catch(a){return null}}function Kr(e,r,t){if(!t)return Vr(Yr(e,r));if(!r)return null;try{return Kr(e,r)}catch(a){return null}}function qr(e){var r=e.FullPaths||ir(e.files),t=[];for(var a=0;a<r.length;++a)if(r[a].slice(-1)!=\"/\")t.push(r[a].replace(/^Root Entry[\\/]/,\"\"));return t.sort()}function Qr(e,r,t){if(e.FullPaths){if(Array.isArray(t)&&typeof t[0]==\"string\"){t=t.join(\"\")}if(typeof t==\"string\"){var a;if(_)a=A(t);else a=R(t);return Qe.utils.cfb_add(e,r,a)}Qe.utils.cfb_add(e,r,t)}else e.file(r,t)}function et(){return Qe.utils.cfb_new()}function rt(e,r){switch(r.type){case\"base64\":return Qe.read(e,{type:\"base64\"});case\"binary\":return Qe.read(e,{type:\"binary\"});case\"buffer\":;case\"array\":return Qe.read(e,{type:\"buffer\"});}throw new Error(\"Unrecognized type \"+r.type)}function tt(e,r){if(e.charAt(0)==\"/\")return e.slice(1);var t=r.split(\"/\");if(r.slice(-1)!=\"/\")t.pop();var a=e.split(\"/\");while(a.length!==0){var n=a.shift();if(n===\"..\")t.pop();else if(n!==\".\")t.push(n)}return t.join(\"/\")}var at='<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\\r\\n';var nt=/\\s([^\"\\s?>\\/]+)\\s*=\\s*((?:\")([^\"]*)(?:\")|(?:')([^']*)(?:')|([^'\">\\s]+))/g;var it=/<[\\/\\?]?[a-zA-Z0-9:_-]+(?:\\s+[^\"\\s?<>\\/]+\\s*=\\s*(?:\"[^\"]*\"|'[^']*'|[^'\"<>\\s=]+))*\\s*[\\/\\?]?>/gm,st=/<[^<>]*>/g;var lt=at.match(it)?it:st;var ot=/<\\w*:/,ct=/<(\\/?)\\w+:/;function ft(e,r,t){var a={};var n=0,i=0;for(;n!==e.length;++n)if((i=e.charCodeAt(n))===32||i===10||i===13)break;if(!r)a[0]=e.slice(0,n);if(n===e.length)return a;var s=e.match(nt),l=0,o=\"\",c=0,f=\"\",u=\"\",h=1;if(s)for(c=0;c!=s.length;++c){u=s[c].slice(1);for(i=0;i!=u.length;++i)if(u.charCodeAt(i)===61)break;f=u.slice(0,i).trim();while(u.charCodeAt(i+1)==32)++i;h=(n=u.charCodeAt(i+1))==34||n==39?1:0;o=u.slice(i+1+h,u.length-h);for(l=0;l!=f.length;++l)if(f.charCodeAt(l)===58)break;if(l===f.length){if(f.indexOf(\"_\")>0)f=f.slice(0,f.indexOf(\"_\"));a[f]=o;if(!t)a[f.toLowerCase()]=o}else{var d=(l===5&&f.slice(0,5)===\"xmlns\"?\"xmlns\":\"\")+f.slice(l+1);if(a[d]&&f.slice(l-3,l)==\"ext\")continue;a[d]=o;if(!t)a[d.toLowerCase()]=o}}return a}function ut(e,r,t){var a={};var n=0,i=0;for(;n!==e.length;++n)if((i=e.charCodeAt(n))===32||i===10||i===13)break;if(!r)a[0]=e.slice(0,n);if(n===e.length)return a;var s=e.match(nt),l=0,o=\"\",c=0,f=\"\",u=\"\",h=1;if(s)for(c=0;c!=s.length;++c){u=s[c].slice(1);for(i=0;i!=u.length;++i)if(u.charCodeAt(i)===61)break;f=u.slice(0,i).trim();while(u.charCodeAt(i+1)==32)++i;h=(n=u.charCodeAt(i+1))==34||n==39?1:0;o=u.slice(i+1+h,u.length-h);if(f.indexOf(\"_\")>0)f=f.slice(0,f.indexOf(\"_\"));a[f]=o;if(!t)a[f.toLowerCase()]=o}return a}function ht(e){return e.replace(ct,\"<$1\")}var dt={\"&quot;\":'\"',\"&apos;\":\"'\",\"&gt;\":\">\",\"&lt;\":\"<\",\"&amp;\":\"&\"};var pt=lr(dt);var mt=function(){var e=/&(?:quot|apos|gt|lt|amp|#x?([\\da-fA-F]+));/gi,r=/_x([\\da-fA-F]{4})_/gi;function t(a){var n=a+\"\",i=n.indexOf(\"<![CDATA[\");if(i==-1)return n.replace(e,function(e,r){return dt[e]||String.fromCharCode(parseInt(r,e.indexOf(\"x\")>-1?16:10))||e}).replace(r,function(e,r){return String.fromCharCode(parseInt(r,16))});var s=n.indexOf(\"]]>\");return t(n.slice(0,i))+n.slice(i+9,s)+t(n.slice(s+3))}return function a(e,r){var a=t(e);return r?a.replace(/\\r\\n/g,\"\\n\"):a}}();var vt=/[&<>'\"]/g,gt=/[\\u0000-\\u0008\\u000b-\\u001f\\uFFFE-\\uFFFF]/g;function bt(e){var r=e+\"\";return r.replace(vt,function(e){return pt[e]}).replace(gt,function(e){return\"_x\"+(\"000\"+e.charCodeAt(0).toString(16)).slice(-4)+\"_\"})}function wt(e){return bt(e).replace(/ /g,\"_x0020_\")}var kt=/[\\u0000-\\u001f]/g;function yt(e){var r=e+\"\";return r.replace(vt,function(e){return pt[e]}).replace(/\\n/g,\"<br/>\").replace(kt,function(e){return\"&#x\"+(\"000\"+e.charCodeAt(0).toString(16)).slice(-4)+\";\"})}function xt(e){var r=e+\"\";return r.replace(vt,function(e){return pt[e]}).replace(kt,function(e){return\"&#x\"+e.charCodeAt(0).toString(16).toUpperCase()+\";\"})}var Ct=function(){var e=/&#(\\d+);/g;function r(e,r){return String.fromCharCode(parseInt(r,10))}return function t(a){return a.replace(e,r)}}();function St(e){return e.replace(/(\\r\\n|[\\r\\n])/g,\"&#10;\")}function _t(e){switch(e){case 1:;case true:;case\"1\":;case\"true\":return true;case 0:;case false:;case\"0\":;case\"false\":return false;}return false}function At(e){var r=\"\",t=0,a=0,n=0,i=0,s=0,l=0;while(t<e.length){a=e.charCodeAt(t++);if(a<128){r+=String.fromCharCode(a);continue}n=e.charCodeAt(t++);if(a>191&&a<224){s=(a&31)<<6;s|=n&63;r+=String.fromCharCode(s);continue}i=e.charCodeAt(t++);if(a<240){r+=String.fromCharCode((a&15)<<12|(n&63)<<6|i&63);continue}s=e.charCodeAt(t++);l=((a&7)<<18|(n&63)<<12|(i&63)<<6|s&63)-65536;r+=String.fromCharCode(55296+(l>>>10&1023));r+=String.fromCharCode(56320+(l&1023))}return r}function Tt(e){var r=E(2*e.length),t,a,n=1,i=0,s=0,l;for(a=0;a<e.length;a+=n){n=1;if((l=e.charCodeAt(a))<128)t=l;else if(l<224){t=(l&31)*64+(e.charCodeAt(a+1)&63);n=2}else if(l<240){t=(l&15)*4096+(e.charCodeAt(a+1)&63)*64+(e.charCodeAt(a+2)&63);n=3}else{n=4;t=(l&7)*262144+(e.charCodeAt(a+1)&63)*4096+(e.charCodeAt(a+2)&63)*64+(e.charCodeAt(a+3)&63);t-=65536;s=55296+(t>>>10&1023);t=56320+(t&1023)}if(s!==0){r[i++]=s&255;r[i++]=s>>>8;s=0}r[i++]=t%256;r[i++]=t>>>8}return r.slice(0,i).toString(\"ucs2\")}function Et(e){return A(e,\"binary\").toString(\"utf8\")}var Ft=\"foo bar bazâð£\";var Dt=_&&(Et(Ft)==At(Ft)&&Et||Tt(Ft)==At(Ft)&&Tt)||At;var Ot=_?function(e){return A(e,\"utf8\").toString(\"binary\")}:function(e){var r=[],t=0,a=0,n=0;while(t<e.length){a=e.charCodeAt(t++);switch(true){case a<128:r.push(String.fromCharCode(a));break;case a<2048:r.push(String.fromCharCode(192+(a>>6)));r.push(String.fromCharCode(128+(a&63)));break;case a>=55296&&a<57344:a-=55296;n=e.charCodeAt(t++)-56320+(a<<10);r.push(String.fromCharCode(240+(n>>18&7)));r.push(String.fromCharCode(144+(n>>12&63)));r.push(String.fromCharCode(128+(n>>6&63)));r.push(String.fromCharCode(128+(n&63)));break;default:r.push(String.fromCharCode(224+(a>>12)));r.push(String.fromCharCode(128+(a>>6&63)));r.push(String.fromCharCode(128+(a&63)));}}return r.join(\"\")};var Nt=function(){var e=[[\"nbsp\",\" \"],[\"middot\",\"·\"],[\"quot\",'\"'],[\"apos\",\"'\"],[\"gt\",\">\"],[\"lt\",\"<\"],[\"amp\",\"&\"]].map(function(e){return[new RegExp(\"&\"+e[0]+\";\",\"ig\"),e[1]]});return function r(t){var a=t.replace(/^[\\t\\n\\r ]+/,\"\").replace(/(^|[^\\t\\n\\r ])[\\t\\n\\r ]+$/,\"$1\").replace(/>\\s+/g,\">\").replace(/\\b\\s+</g,\"<\").replace(/[\\t\\n\\r ]+/g,\" \").replace(/<\\s*[bB][rR]\\s*\\/?>/g,\"\\n\").replace(/<[^<>]*>/g,\"\");for(var n=0;n<e.length;++n)a=a.replace(e[n][0],e[n][1]);return a}}();var Mt=/<\\/?(?:vt:)?variant>/g,It=/<(?:vt:)([^<\"'>]*)>([\\s\\S]*)</;function Pt(e,r){var t=ft(e);var a=$r(e,t.baseType)||[];var n=[];if(a.length!=t.size){if(r.WTF)throw new Error(\"unexpected vector length \"+a.length+\" != \"+t.size);return n}a.forEach(function(e){var r=e.replace(Mt,\"\").match(It);if(r)n.push({v:Dt(r[2]),t:r[1]})});return n}var Rt=/(^\\s|\\s$|\\n)/;function Lt(e,r){return\"<\"+e+(r.match(Rt)?' xml:space=\"preserve\"':\"\")+\">\"+r+\"</\"+e+\">\"}function Ut(e){return ir(e).map(function(r){return\" \"+r+'=\"'+e[r]+'\"'}).join(\"\")}function Bt(e,r,t){return\"<\"+e+(t!=null?Ut(t):\"\")+(r!=null?(r.match(Rt)?' xml:space=\"preserve\"':\"\")+\">\"+r+\"</\"+e:\"/\")+\">\"}function zt(e,r){try{return e.toISOString().replace(/\\.\\d*/,\"\")}catch(t){if(r)throw t}return\"\"}function $t(e,r){switch(typeof e){case\"string\":var t=Bt(\"vt:lpwstr\",bt(e));if(r)t=t.replace(/&quot;/g,\"_x0022_\");return t;case\"number\":return Bt((e|0)==e?\"vt:i4\":\"vt:r8\",bt(String(e)));case\"boolean\":return Bt(\"vt:bool\",e?\"true\":\"false\");}if(e instanceof Date)return Bt(\"vt:filetime\",zt(e));throw new Error(\"Unable to serialize \"+e)}function Wt(e){if(_&&Buffer.isBuffer(e))return e.toString(\"utf8\");if(typeof e===\"string\")return e;if(typeof Uint8Array!==\"undefined\"&&e instanceof Uint8Array)return Dt(N(I(e)));throw new Error(\"Bad input format: expected Buffer or string\")}var jt=/<([\\/]?)([^\\s?><!\\/:\"]*:|)([^\\s?<>:\\/\"]+)(?:\\s+[^<>=?\"'\\s]+=\"[^\"]*?\")*\\s*[\\/]?>/gm;var Ht={CORE_PROPS:\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\",CUST_PROPS:\"http://schemas.openxmlformats.org/officeDocument/2006/custom-properties\",EXT_PROPS:\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\",CT:\"http://schemas.openxmlformats.org/package/2006/content-types\",RELS:\"http://schemas.openxmlformats.org/package/2006/relationships\",TCMNT:\"http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments\",dc:\"http://purl.org/dc/elements/1.1/\",dcterms:\"http://purl.org/dc/terms/\",dcmitype:\"http://purl.org/dc/dcmitype/\",mx:\"http://schemas.microsoft.com/office/mac/excel/2008/main\",r:\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\",sjs:\"http://schemas.openxmlformats.org/package/2006/sheetjs/core-properties\",vt:\"http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes\",xsi:\"http://www.w3.org/2001/XMLSchema-instance\",xsd:\"http://www.w3.org/2001/XMLSchema\"};var Vt=[\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\",\"http://purl.oclc.org/ooxml/spreadsheetml/main\",\"http://schemas.microsoft.com/office/excel/2006/main\",\"http://schemas.microsoft.com/office/excel/2006/2\"];var Xt={o:\"urn:schemas-microsoft-com:office:office\",x:\"urn:schemas-microsoft-com:office:excel\",ss:\"urn:schemas-microsoft-com:office:spreadsheet\",dt:\"uuid:C2F41010-65B3-11d1-A29F-00AA00C14882\",mv:\"http://macVmlSchemaUri\",v:\"urn:schemas-microsoft-com:vml\",html:\"http://www.w3.org/TR/REC-html40\"};function Gt(e,r){var t=1-2*(e[r+7]>>>7);var a=((e[r+7]&127)<<4)+(e[r+6]>>>4&15);var n=e[r+6]&15;for(var i=5;i>=0;--i)n=n*256+e[r+i];if(a==2047)return n==0?t*Infinity:NaN;if(a==0)a=-1022;else{a-=1023;n+=Math.pow(2,52)}return t*Math.pow(2,a-52)*n}function Yt(e,r,t){var a=(r<0||1/r==-Infinity?1:0)<<7,n=0,i=0;var s=a?-r:r;if(!isFinite(s)){n=2047;i=isNaN(r)?26985:0}else if(s==0)n=i=0;else{n=Math.floor(Math.log(s)/Math.LN2);i=s*Math.pow(2,52-n);if(n<=-1023&&(!isFinite(i)||i<Math.pow(2,52))){n=-1022}else{i-=Math.pow(2,52);n+=1023}}for(var l=0;l<=5;++l,i/=256)e[t+l]=i&255;e[t+6]=(n&15)<<4|i&15;e[t+7]=n>>4|a}var Jt=function(e){var r=[],t=10240;for(var a=0;a<e[0].length;++a)if(e[0][a])for(var n=0,i=e[0][a].length;n<i;n+=t)r.push.apply(r,e[0][a].slice(n,n+t));return r};var Zt=_?function(e){return e[0].length>0&&Buffer.isBuffer(e[0][0])?Buffer.concat(e[0].map(function(e){return Buffer.isBuffer(e)?e:A(e)})):Jt(e)}:Jt;var Kt=function(e,r,t){var a=[];for(var n=r;n<t;n+=2)a.push(String.fromCharCode(ba(e,n)));return a.join(\"\").replace(L,\"\")};var qt=_?function(e,r,t){if(!Buffer.isBuffer(e)||!T)return Kt(e,r,t);return e.toString(\"utf16le\",r,t).replace(L,\"\")}:Kt;var Qt=function(e,r,t){var a=[];for(var n=r;n<r+t;++n)a.push((\"0\"+e[n].toString(16)).slice(-2));return a.join(\"\")};var ea=_?function(e,r,t){return Buffer.isBuffer(e)?e.toString(\"hex\",r,r+t):Qt(e,r,t)}:Qt;var ra=function(e,r,t){var a=[];for(var n=r;n<t;n++)a.push(String.fromCharCode(ga(e,n)));return a.join(\"\")};var ta=_?function Pc(e,r,t){return Buffer.isBuffer(e)?e.toString(\"utf8\",r,t):ra(e,r,t)}:ra;var aa=function(e,r){var t=ka(e,r);return t>0?ta(e,r+4,r+4+t-1):\"\"};var na=aa;var ia=function(e,r){var t=ka(e,r);return t>0?ta(e,r+4,r+4+t-1):\"\"};var sa=ia;var la=function(e,r){var t=2*ka(e,r);return t>0?ta(e,r+4,r+4+t-1):\"\"};var oa=la;var ca=function Rc(e,r){var t=ka(e,r);return t>0?qt(e,r+4,r+4+t):\"\"};var fa=ca;var ua=function(e,r){var t=ka(e,r);return t>0?ta(e,r+4,r+4+t):\"\"};var ha=ua;var da=function(e,r){return Gt(e,r)};var pa=da;var ma=function Lc(e){return Array.isArray(e)||typeof Uint8Array!==\"undefined\"&&e instanceof Uint8Array};if(_){na=function Uc(e,r){if(!Buffer.isBuffer(e))return aa(e,r);var t=e.readUInt32LE(r);return t>0?e.toString(\"utf8\",r+4,r+4+t-1):\"\"};sa=function Bc(e,r){if(!Buffer.isBuffer(e))return ia(e,r);var t=e.readUInt32LE(r);return t>0?e.toString(\"utf8\",r+4,r+4+t-1):\"\"};oa=function zc(e,r){if(!Buffer.isBuffer(e)||!T)return la(e,r);var t=2*e.readUInt32LE(r);return e.toString(\"utf16le\",r+4,r+4+t-1)};fa=function $c(e,r){if(!Buffer.isBuffer(e)||!T)return ca(e,r);var t=e.readUInt32LE(r);return e.toString(\"utf16le\",r+4,r+4+t)};ha=function Wc(e,r){if(!Buffer.isBuffer(e))return ua(e,r);var t=e.readUInt32LE(r);return e.toString(\"utf8\",r+4,r+4+t)};pa=function jc(e,r){if(Buffer.isBuffer(e))return e.readDoubleLE(r);return da(e,r)};ma=function Hc(e){return Buffer.isBuffer(e)||Array.isArray(e)||typeof Uint8Array!==\"undefined\"&&e instanceof Uint8Array}}function va(){qt=function(e,r,t){return a.utils.decode(1200,e.slice(r,t)).replace(L,\"\")};ta=function(e,r,t){return a.utils.decode(65001,e.slice(r,t))};na=function(e,r){var n=ka(e,r);return n>0?a.utils.decode(t,e.slice(r+4,r+4+n-1)):\"\"};sa=function(e,t){var n=ka(e,t);return n>0?a.utils.decode(r,e.slice(t+4,t+4+n-1)):\"\"};oa=function(e,r){var t=2*ka(e,r);return t>0?a.utils.decode(1200,e.slice(r+4,r+4+t-1)):\"\"};fa=function(e,r){var t=ka(e,r);return t>0?a.utils.decode(1200,e.slice(r+4,r+4+t)):\"\"};ha=function(e,r){var t=ka(e,r);return t>0?a.utils.decode(65001,e.slice(r+4,r+4+t)):\"\"}}if(typeof a!==\"undefined\")va();var ga=function(e,r){return e[r]};var ba=function(e,r){return e[r+1]*(1<<8)+e[r]};var wa=function(e,r){var t=e[r+1]*(1<<8)+e[r];return t<32768?t:(65535-t+1)*-1};var ka=function(e,r){return e[r+3]*(1<<24)+(e[r+2]<<16)+(e[r+1]<<8)+e[r]};var ya=function(e,r){return e[r+3]<<24|e[r+2]<<16|e[r+1]<<8|e[r]};var xa=function(e,r){return e[r]<<24|e[r+1]<<16|e[r+2]<<8|e[r+3]};function Ca(e,t){var n=\"\",i,s,l=[],o,c,f,u;switch(t){case\"dbcs\":u=this.l;if(_&&Buffer.isBuffer(this)&&T)n=this.slice(this.l,this.l+2*e).toString(\"utf16le\");else for(f=0;f<e;++f){n+=String.fromCharCode(ba(this,u));u+=2}e*=2;break;case\"utf8\":n=ta(this,this.l,this.l+e);break;case\"utf16le\":e*=2;n=qt(this,this.l,this.l+e);break;case\"wstr\":if(typeof a!==\"undefined\")n=a.utils.decode(r,this.slice(this.l,this.l+2*e));else return Ca.call(this,e,\"dbcs\");e=2*e;break;case\"lpstr-ansi\":n=na(this,this.l);e=4+ka(this,this.l);break;case\"lpstr-cp\":n=sa(this,this.l);e=4+ka(this,this.l);break;case\"lpwstr\":n=oa(this,this.l);e=4+2*ka(this,this.l);break;case\"lpp4\":e=4+ka(this,this.l);n=fa(this,this.l);if(e&2)e+=2;break;case\"8lpp4\":e=4+ka(this,this.l);n=ha(this,this.l);if(e&3)e+=4-(e&3);break;case\"cstr\":e=0;n=\"\";while((o=ga(this,this.l+e++))!==0)l.push(m(o));n=l.join(\"\");break;case\"_wstr\":e=0;n=\"\";while((o=ba(this,this.l+e))!==0){l.push(m(o));e+=2}e+=2;n=l.join(\"\");break;case\"dbcs-cont\":n=\"\";u=this.l;for(f=0;f<e;++f){if(this.lens&&this.lens.indexOf(u)!==-1){o=ga(this,u);this.l=u+1;c=Ca.call(this,e-f,o?\"dbcs-cont\":\"sbcs-cont\");return l.join(\"\")+c}l.push(m(ba(this,u)));u+=2}n=l.join(\"\");e*=2;break;case\"cpstr\":if(typeof a!==\"undefined\"){n=a.utils.decode(r,this.slice(this.l,this.l+e));break};case\"sbcs-cont\":n=\"\";u=this.l;for(f=0;f!=e;++f){if(this.lens&&this.lens.indexOf(u)!==-1){o=ga(this,u);this.l=u+1;c=Ca.call(this,e-f,o?\"dbcs-cont\":\"sbcs-cont\");return l.join(\"\")+c}l.push(m(ga(this,u)));u+=1}n=l.join(\"\");break;default:switch(e){case 1:i=ga(this,this.l);this.l++;return i;case 2:i=(t===\"i\"?wa:ba)(this,this.l);this.l+=2;return i;case 4:;case-4:if(t===\"i\"||(this[this.l+3]&128)===0){i=(e>0?ya:xa)(this,this.l);this.l+=4;return i}else{s=ka(this,this.l);this.l+=4}return s;case 8:;case-8:if(t===\"f\"){if(e==8)s=pa(this,this.l);else s=pa([this[this.l+7],this[this.l+6],this[this.l+5],this[this.l+4],this[this.l+3],this[this.l+2],this[this.l+1],this[this.l+0]],0);this.l+=8;return s}else e=8;case 16:n=ea(this,this.l,e);break;};}this.l+=e;return n}var Sa=function(e,r,t){e[t]=r&255;e[t+1]=r>>>8&255;e[t+2]=r>>>16&255;e[t+3]=r>>>24&255};var _a=function(e,r,t){e[t]=r&255;e[t+1]=r>>8&255;e[t+2]=r>>16&255;e[t+3]=r>>24&255};var Aa=function(e,r,t){e[t]=r&255;e[t+1]=r>>>8&255};function Ta(e,n,i){var s=0,l=0;if(i===\"dbcs\"){for(l=0;l!=n.length;++l)Aa(this,n.charCodeAt(l),this.l+2*l);s=2*n.length}else if(i===\"sbcs\"||i==\"cpstr\"){if(typeof a!==\"undefined\"&&t==874){for(l=0;l!=n.length;++l){var o=a.utils.encode(t,n.charAt(l));this[this.l+l]=o[0]}s=n.length}else if(typeof a!==\"undefined\"&&i==\"cpstr\"){o=a.utils.encode(r,n);if(o.length==n.length)for(l=0;l<n.length;++l)if(o[l]==0&&n.charCodeAt(l)!=0)o[l]=95;if(o.length==2*n.length)for(l=0;l<n.length;++l)if(o[2*l]==0&&o[2*l+1]==0&&n.charCodeAt(l)!=0)o[2*l]=95;for(l=0;l<o.length;++l)this[this.l+l]=o[l];s=o.length}else{n=n.replace(/[^\\x00-\\x7F]/g,\"_\");for(l=0;l!=n.length;++l)this[this.l+l]=n.charCodeAt(l)&255;s=n.length}}else if(i===\"hex\"){for(;l<e;++l){this[this.l++]=parseInt(n.slice(2*l,2*l+2),16)||0}return this}else if(i===\"utf16le\"){var c=Math.min(this.l+e,this.length);for(l=0;l<Math.min(n.length,e);++l){var f=n.charCodeAt(l);this[this.l++]=f&255;this[this.l++]=f>>8}while(this.l<c)this[this.l++]=0;return this}else switch(e){case 1:s=1;this[this.l]=n&255;break;case 2:s=2;this[this.l]=n&255;n>>>=8;this[this.l+1]=n&255;break;case 3:s=3;this[this.l]=n&255;n>>>=8;this[this.l+1]=n&255;n>>>=8;this[this.l+2]=n&255;break;case 4:s=4;Sa(this,n,this.l);break;case 8:s=8;if(i===\"f\"){Yt(this,n,this.l);break};case 16:break;case-4:s=4;_a(this,n,this.l);break;}this.l+=s;return this}function Ea(e,r){var t=ea(this,this.l,e.length>>1);if(t!==e)throw new Error(r+\"Expected \"+e+\" saw \"+t);this.l+=e.length>>1}function Fa(e,r){e.l=r;e._R=Ca;e.chk=Ea;e._W=Ta}function Da(e,r){e.l+=r}function Oa(e){var r=E(e);Fa(r,0);return r}function Na(e,r,t){if(!e)return;var a,n,i;Fa(e,e.l||0);var s=e.length,l=0,o=0;while(e.l<s){l=e._R(1);if(l&128)l=(l&127)+((e._R(1)&127)<<7);var c=XLSBRecordEnum[l]||XLSBRecordEnum[65535];a=e._R(1);i=a&127;for(n=1;n<4&&a&128;++n)i+=((a=e._R(1))&127)<<7*n;o=e.l+i;var f=c.f&&c.f(e,i,t);e.l=o;if(r(f,c,l))return}}function Ma(){var e=[],r=_?16384:2048;var t=_&&typeof Oa(r).copy==\"function\";var a=function f(e){var r=Oa(e);Fa(r,0);return r};var n=a(r);var i=function u(){if(!n)return;if(n.l){if(n.length>n.l){n=n.slice(0,n.l);n.l=n.length}if(n.length>0)e.push(n)}n=null};var s=function h(e){if(n&&e<n.length-n.l)return n;i();return n=a(Math.max(e+1,r))};var l=function d(){i();return P(e)};var o=function(){i();return e};var c=function p(e){i();n=e;if(n.l==null)n.l=n.length;s(r)};return{next:s,push:c,end:l,_bufs:e,end2:o}}function Ia(e,r,t,a){var n=+r,i;if(isNaN(n))return;if(!a)a=XLSBRecordEnum[n].p||(t||[]).length||0;i=1+(n>=128?1:0)+1;if(a>=128)++i;if(a>=16384)++i;if(a>=2097152)++i;var s=e.next(i);if(n<=127)s._W(1,n);else{s._W(1,(n&127)+128);s._W(1,n>>7)}for(var l=0;l!=4;++l){if(a>=128){s._W(1,(a&127)+128);a>>=7}else{s._W(1,a);break}}if(a>0&&ma(t))e.push(t)}function Pa(e,r,t){var a=yr(e);if(r.s){if(a.cRel)a.c+=r.s.c;if(a.rRel)a.r+=r.s.r}else{if(a.cRel)a.c+=r.c;if(a.rRel)a.r+=r.r}if(!t||t.biff<12){while(a.c>=256)a.c-=256;while(a.r>=65536)a.r-=65536}return a}function Ra(e,r,t){var a=yr(e);a.s=Pa(a.s,r.s,t);a.e=Pa(a.e,r.s,t);return a}function La(e,r){if(e.cRel&&e.c<0){e=yr(e);while(e.c<0)e.c+=r>8?16384:256}if(e.rRel&&e.r<0){e=yr(e);while(e.r<0)e.r+=r>8?1048576:r>5?65536:16384}var t=Ja(e);if(!e.cRel&&e.cRel!=null)t=Va(t);if(!e.rRel&&e.rRel!=null)t=$a(t);return t}function Ua(e,r){if(e.s.r==0&&!e.s.rRel){if(e.e.r==(r.biff>=12?1048575:r.biff>=8?65536:16384)&&!e.e.rRel){return(e.s.cRel?\"\":\"$\")+Ha(e.s.c)+\":\"+(e.e.cRel?\"\":\"$\")+Ha(e.e.c)}}if(e.s.c==0&&!e.s.cRel){if(e.e.c==(r.biff>=12?16383:255)&&!e.e.cRel){return(e.s.rRel?\"\":\"$\")+za(e.s.r)+\":\"+(e.e.rRel?\"\":\"$\")+za(e.e.r)}}return La(e.s,r.biff)+\":\"+La(e.e,r.biff)}function Ba(e){return parseInt(Wa(e),10)-1}function za(e){return\"\"+(e+1)}function $a(e){return e.replace(/([A-Z]|^)(\\d+)$/,\"$1$$$2\")}function Wa(e){return e.replace(/\\$(\\d+)$/,\"$1\")}function ja(e){var r=Xa(e),t=0,a=0;for(;a!==r.length;++a)t=26*t+r.charCodeAt(a)-64;return t-1}function Ha(e){if(e<0)throw new Error(\"invalid column \"+e);var r=\"\";for(++e;e;e=Math.floor((e-1)/26))r=String.fromCharCode((e-1)%26+65)+r;return r}function Va(e){return e.replace(/^([A-Z])/,\"$$$1\")}function Xa(e){return e.replace(/^\\$([A-Z])/,\"$1\")}function Ga(e){return e.replace(/(\\$?[A-Z]*)(\\$?\\d*)/,\"$1,$2\").split(\",\")}function Ya(e){var r=0,t=0;for(var a=0;a<e.length;++a){var n=e.charCodeAt(a);if(n>=48&&n<=57)r=10*r+(n-48);else if(n>=65&&n<=90)t=26*t+(n-64)}return{c:t-1,r:r-1}}function Ja(e){var r=e.c+1;var t=\"\";for(;r;r=(r-1)/26|0)t=String.fromCharCode((r-1)%26+65)+t;return t+(e.r+1)}function Za(e){var r=e.indexOf(\":\");if(r==-1)return{s:Ya(e),e:Ya(e)};return{s:Ya(e.slice(0,r)),e:Ya(e.slice(r+1))}}function Ka(e,r){if(typeof r===\"undefined\"||typeof r===\"number\"){return Ka(e.s,e.e)}if(typeof e!==\"string\")e=Ja(e);if(typeof r!==\"string\")r=Ja(r);return e==r?e:e+\":\"+r}function qa(e){var r=Za(e);return\"$\"+Ha(r.s.c)+\"$\"+za(r.s.r)+\":$\"+Ha(r.e.c)+\"$\"+za(r.e.r)}function Qa(e,r){if(!e&&!(r&&r.biff<=5&&r.biff>=2))throw new Error(\"empty sheet name\");if(/[^\\w\\u4E00-\\u9FFF\\u3040-\\u30FF]/.test(e))return\"'\"+e.replace(/'/g,\"''\")+\"'\";return e}function en(e){var r={s:{c:0,r:0},e:{c:0,r:0}};var t=0,a=0,n=0;var i=e.length;for(t=0;a<i;++a){if((n=e.charCodeAt(a)-64)<1||n>26)break;t=26*t+n}r.s.c=--t;for(t=0;a<i;++a){if((n=e.charCodeAt(a)-48)<0||n>9)break;t=10*t+n}r.s.r=--t;if(a===i||n!=10){r.e.c=r.s.c;r.e.r=r.s.r;return r}++a;for(t=0;a!=i;++a){if((n=e.charCodeAt(a)-64)<1||n>26)break;t=26*t+n}r.e.c=--t;for(t=0;a!=i;++a){if((n=e.charCodeAt(a)-48)<0||n>9)break;t=10*t+n}r.e.r=--t;return r}function rn(e,r){var t=e.t==\"d\"&&r instanceof Date;if(e.z!=null)try{return e.w=$e(e.z,t?dr(r):r);\n}catch(a){}try{return e.w=$e((e.XF||{}).numFmtId||(t?14:0),t?dr(r):r)}catch(a){return\"\"+r}}function tn(e,r,t){if(e==null||e.t==null||e.t==\"z\")return\"\";if(e.w!==undefined)return e.w;if(e.t==\"d\"&&!e.z&&t&&t.dateNF)e.z=t.dateNF;if(e.t==\"e\")return En[e.v]||e.v;if(r==undefined)return rn(e,e.v);return rn(e,r)}function an(e,r){var t=r&&r.sheet?r.sheet:\"Sheet1\";var a={};a[t]=e;return{SheetNames:[t],Sheets:a}}function nn(e){var r={};var t=e||{};if(t.dense)r[\"!data\"]=[];return r}function sn(e,r,t){var a=t||{};var n=e?e[\"!data\"]!=null:a.dense;if(b!=null&&n==null)n=b;var i=e||(n?{\"!data\":[]}:{});if(n&&!i[\"!data\"])i[\"!data\"]=[];var s=0,l=0;if(i&&a.origin!=null){if(typeof a.origin==\"number\")s=a.origin;else{var o=typeof a.origin==\"string\"?Ya(a.origin):a.origin;s=o.r;l=o.c}}var c={s:{c:1e7,r:1e7},e:{c:0,r:0}};if(i[\"!ref\"]){var f=en(i[\"!ref\"]);c.s.c=f.s.c;c.s.r=f.s.r;c.e.c=Math.max(c.e.c,f.e.c);c.e.r=Math.max(c.e.r,f.e.r);if(s==-1)c.e.r=s=i[\"!ref\"]?f.e.r+1:0}else{c.s.c=c.e.c=c.s.r=c.e.r=0}var u=[],h=false;for(var d=0;d!=r.length;++d){if(!r[d])continue;if(!Array.isArray(r[d]))throw new Error(\"aoa_to_sheet expects an array of arrays\");var p=s+d;if(n){if(!i[\"!data\"][p])i[\"!data\"][p]=[];u=i[\"!data\"][p]}var m=r[d];for(var v=0;v!=m.length;++v){if(typeof m[v]===\"undefined\")continue;var g={v:m[v],t:\"\"};var w=l+v;if(c.s.r>p)c.s.r=p;if(c.s.c>w)c.s.c=w;if(c.e.r<p)c.e.r=p;if(c.e.c<w)c.e.c=w;h=true;if(m[v]&&typeof m[v]===\"object\"&&!Array.isArray(m[v])&&!(m[v]instanceof Date))g=m[v];else{if(Array.isArray(g.v)){g.f=m[v][1];g.v=g.v[0]}if(g.v===null){if(g.f)g.t=\"n\";else if(a.nullError){g.t=\"e\";g.v=0}else if(!a.sheetStubs)continue;else g.t=\"z\"}else if(typeof g.v===\"number\"){if(isFinite(g.v))g.t=\"n\";else if(isNaN(g.v)){g.t=\"e\";g.v=15}else{g.t=\"e\";g.v=7}}else if(typeof g.v===\"boolean\")g.t=\"b\";else if(g.v instanceof Date){g.z=a.dateNF||q[14];if(!a.UTC)g.v=Ir(g.v);if(a.cellDates){g.t=\"d\";g.w=$e(g.z,dr(g.v,a.date1904))}else{g.t=\"n\";g.v=dr(g.v,a.date1904);g.w=$e(g.z,g.v)}}else g.t=\"s\"}if(n){if(u[w]&&u[w].z)g.z=u[w].z;u[w]=g}else{var k=Ha(w)+(p+1);if(i[k]&&i[k].z)g.z=i[k].z;i[k]=g}}}if(h&&c.s.c<104e5)i[\"!ref\"]=Ka(c);return i}function ln(e,r){return sn(null,e,r)}var on=2;var cn=3;var fn=11;var un=12;var hn=19;var dn=64;var pn=65;var mn=71;var vn=4108;var gn=4126;var bn=80;var wn=81;var kn=[bn,wn];var yn={1:{n:\"CodePage\",t:on},2:{n:\"Category\",t:bn},3:{n:\"PresentationFormat\",t:bn},4:{n:\"ByteCount\",t:cn},5:{n:\"LineCount\",t:cn},6:{n:\"ParagraphCount\",t:cn},7:{n:\"SlideCount\",t:cn},8:{n:\"NoteCount\",t:cn},9:{n:\"HiddenCount\",t:cn},10:{n:\"MultimediaClipCount\",t:cn},11:{n:\"ScaleCrop\",t:fn},12:{n:\"HeadingPairs\",t:vn},13:{n:\"TitlesOfParts\",t:gn},14:{n:\"Manager\",t:bn},15:{n:\"Company\",t:bn},16:{n:\"LinksUpToDate\",t:fn},17:{n:\"CharacterCount\",t:cn},19:{n:\"SharedDoc\",t:fn},22:{n:\"HyperlinksChanged\",t:fn},23:{n:\"AppVersion\",t:cn,p:\"version\"},24:{n:\"DigSig\",t:pn},26:{n:\"ContentType\",t:bn},27:{n:\"ContentStatus\",t:bn},28:{n:\"Language\",t:bn},29:{n:\"Version\",t:bn},255:{},2147483648:{n:\"Locale\",t:hn},2147483651:{n:\"Behavior\",t:hn},1919054434:{}};var xn={1:{n:\"CodePage\",t:on},2:{n:\"Title\",t:bn},3:{n:\"Subject\",t:bn},4:{n:\"Author\",t:bn},5:{n:\"Keywords\",t:bn},6:{n:\"Comments\",t:bn},7:{n:\"Template\",t:bn},8:{n:\"LastAuthor\",t:bn},9:{n:\"RevNumber\",t:bn},10:{n:\"EditTime\",t:dn},11:{n:\"LastPrinted\",t:dn},12:{n:\"CreatedDate\",t:dn},13:{n:\"ModifiedDate\",t:dn},14:{n:\"PageCount\",t:cn},15:{n:\"WordCount\",t:cn},16:{n:\"CharCount\",t:cn},17:{n:\"Thumbnail\",t:mn},18:{n:\"Application\",t:bn},19:{n:\"DocSecurity\",t:cn},255:{},2147483648:{n:\"Locale\",t:hn},2147483651:{n:\"Behavior\",t:hn},1919054434:{}};var Cn={1:\"US\",2:\"CA\",3:\"\",7:\"RU\",20:\"EG\",30:\"GR\",31:\"NL\",32:\"BE\",33:\"FR\",34:\"ES\",36:\"HU\",39:\"IT\",41:\"CH\",43:\"AT\",44:\"GB\",45:\"DK\",46:\"SE\",47:\"NO\",48:\"PL\",49:\"DE\",52:\"MX\",55:\"BR\",61:\"AU\",64:\"NZ\",66:\"TH\",81:\"JP\",82:\"KR\",84:\"VN\",86:\"CN\",90:\"TR\",105:\"JS\",213:\"DZ\",216:\"MA\",218:\"LY\",351:\"PT\",354:\"IS\",358:\"FI\",420:\"CZ\",886:\"TW\",961:\"LB\",962:\"JO\",963:\"SY\",964:\"IQ\",965:\"KW\",966:\"SA\",971:\"AE\",972:\"IL\",974:\"QA\",981:\"IR\",65535:\"US\"};var Sn=[null,\"solid\",\"mediumGray\",\"darkGray\",\"lightGray\",\"darkHorizontal\",\"darkVertical\",\"darkDown\",\"darkUp\",\"darkGrid\",\"darkTrellis\",\"lightHorizontal\",\"lightVertical\",\"lightDown\",\"lightUp\",\"lightGrid\",\"lightTrellis\",\"gray125\",\"gray0625\"];function _n(e){return e.map(function(e){return[e>>16&255,e>>8&255,e&255]})}var An=_n([0,16777215,16711680,65280,255,16776960,16711935,65535,0,16777215,16711680,65280,255,16776960,16711935,65535,8388608,32768,128,8421376,8388736,32896,12632256,8421504,10066431,10040166,16777164,13434879,6684774,16744576,26316,13421823,128,16711935,16776960,65535,8388736,8388608,32896,255,52479,13434879,13434828,16777113,10079487,16751052,13408767,16764057,3368703,3394764,10079232,16763904,16750848,16737792,6710937,9868950,13158,3381606,13056,3355392,10040064,10040166,3355545,3355443,0,16777215,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]);var Tn=yr(An);var En={0:\"#NULL!\",7:\"#DIV/0!\",15:\"#VALUE!\",23:\"#REF!\",29:\"#NAME?\",36:\"#NUM!\",42:\"#N/A\",43:\"#GETTING_DATA\",255:\"#WTF?\"};var Fn={\"#NULL!\":0,\"#DIV/0!\":7,\"#VALUE!\":15,\"#REF!\":23,\"#NAME?\":29,\"#NUM!\":36,\"#N/A\":42,\"#GETTING_DATA\":43,\"#WTF?\":255};var Dn=[\"_xlnm.Consolidate_Area\",\"_xlnm.Auto_Open\",\"_xlnm.Auto_Close\",\"_xlnm.Extract\",\"_xlnm.Database\",\"_xlnm.Criteria\",\"_xlnm.Print_Area\",\"_xlnm.Print_Titles\",\"_xlnm.Recorder\",\"_xlnm.Data_Form\",\"_xlnm.Auto_Activate\",\"_xlnm.Auto_Deactivate\",\"_xlnm.Sheet_Title\",\"_xlnm._FilterDatabase\"];var On={\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\":\"workbooks\",\"application/vnd.ms-excel.sheet.macroEnabled.main+xml\":\"workbooks\",\"application/vnd.ms-excel.sheet.binary.macroEnabled.main\":\"workbooks\",\"application/vnd.ms-excel.addin.macroEnabled.main+xml\":\"workbooks\",\"application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml\":\"workbooks\",\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\":\"sheets\",\"application/vnd.ms-excel.worksheet\":\"sheets\",\"application/vnd.ms-excel.binIndexWs\":\"TODO\",\"application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml\":\"charts\",\"application/vnd.ms-excel.chartsheet\":\"charts\",\"application/vnd.ms-excel.macrosheet+xml\":\"macros\",\"application/vnd.ms-excel.macrosheet\":\"macros\",\"application/vnd.ms-excel.intlmacrosheet\":\"TODO\",\"application/vnd.ms-excel.binIndexMs\":\"TODO\",\"application/vnd.openxmlformats-officedocument.spreadsheetml.dialogsheet+xml\":\"dialogs\",\"application/vnd.ms-excel.dialogsheet\":\"dialogs\",\"application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml\":\"strs\",\"application/vnd.ms-excel.sharedStrings\":\"strs\",\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\":\"styles\",\"application/vnd.ms-excel.styles\":\"styles\",\"application/vnd.openxmlformats-package.core-properties+xml\":\"coreprops\",\"application/vnd.openxmlformats-officedocument.custom-properties+xml\":\"custprops\",\"application/vnd.openxmlformats-officedocument.extended-properties+xml\":\"extprops\",\"application/vnd.openxmlformats-officedocument.customXmlProperties+xml\":\"TODO\",\"application/vnd.openxmlformats-officedocument.spreadsheetml.customProperty\":\"TODO\",\"application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml\":\"comments\",\"application/vnd.ms-excel.comments\":\"comments\",\"application/vnd.ms-excel.threadedcomments+xml\":\"threadedcomments\",\"application/vnd.ms-excel.person+xml\":\"people\",\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml\":\"metadata\",\"application/vnd.ms-excel.sheetMetadata\":\"metadata\",\"application/vnd.ms-excel.pivotTable\":\"TODO\",\"application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml\":\"TODO\",\"application/vnd.openxmlformats-officedocument.drawingml.chart+xml\":\"TODO\",\"application/vnd.ms-office.chartcolorstyle+xml\":\"TODO\",\"application/vnd.ms-office.chartstyle+xml\":\"TODO\",\"application/vnd.ms-office.chartex+xml\":\"TODO\",\"application/vnd.ms-excel.calcChain\":\"calcchains\",\"application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml\":\"calcchains\",\"application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings\":\"TODO\",\"application/vnd.ms-office.activeX\":\"TODO\",\"application/vnd.ms-office.activeX+xml\":\"TODO\",\"application/vnd.ms-excel.attachedToolbars\":\"TODO\",\"application/vnd.ms-excel.connections\":\"TODO\",\"application/vnd.openxmlformats-officedocument.spreadsheetml.connections+xml\":\"TODO\",\"application/vnd.ms-excel.externalLink\":\"links\",\"application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml\":\"links\",\"application/vnd.ms-excel.pivotCacheDefinition\":\"TODO\",\"application/vnd.ms-excel.pivotCacheRecords\":\"TODO\",\"application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml\":\"TODO\",\"application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml\":\"TODO\",\"application/vnd.ms-excel.queryTable\":\"TODO\",\"application/vnd.openxmlformats-officedocument.spreadsheetml.queryTable+xml\":\"TODO\",\"application/vnd.ms-excel.userNames\":\"TODO\",\"application/vnd.ms-excel.revisionHeaders\":\"TODO\",\"application/vnd.ms-excel.revisionLog\":\"TODO\",\"application/vnd.openxmlformats-officedocument.spreadsheetml.revisionHeaders+xml\":\"TODO\",\"application/vnd.openxmlformats-officedocument.spreadsheetml.revisionLog+xml\":\"TODO\",\"application/vnd.openxmlformats-officedocument.spreadsheetml.userNames+xml\":\"TODO\",\"application/vnd.ms-excel.tableSingleCells\":\"TODO\",\"application/vnd.openxmlformats-officedocument.spreadsheetml.tableSingleCells+xml\":\"TODO\",\"application/vnd.ms-excel.slicer\":\"TODO\",\"application/vnd.ms-excel.slicerCache\":\"TODO\",\"application/vnd.ms-excel.slicer+xml\":\"TODO\",\"application/vnd.ms-excel.slicerCache+xml\":\"TODO\",\"application/vnd.ms-excel.wsSortMap\":\"TODO\",\"application/vnd.ms-excel.table\":\"TODO\",\"application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml\":\"TODO\",\"application/vnd.openxmlformats-officedocument.theme+xml\":\"themes\",\"application/vnd.openxmlformats-officedocument.themeOverride+xml\":\"TODO\",\"application/vnd.ms-excel.Timeline+xml\":\"TODO\",\"application/vnd.ms-excel.TimelineCache+xml\":\"TODO\",\"application/vnd.ms-office.vbaProject\":\"vba\",\"application/vnd.ms-office.vbaProjectSignature\":\"TODO\",\"application/vnd.ms-office.volatileDependencies\":\"TODO\",\"application/vnd.openxmlformats-officedocument.spreadsheetml.volatileDependencies+xml\":\"TODO\",\"application/vnd.ms-excel.controlproperties+xml\":\"TODO\",\"application/vnd.openxmlformats-officedocument.model+data\":\"TODO\",\"application/vnd.ms-excel.Survey+xml\":\"TODO\",\"application/vnd.openxmlformats-officedocument.drawing+xml\":\"drawings\",\"application/vnd.openxmlformats-officedocument.drawingml.chartshapes+xml\":\"TODO\",\"application/vnd.openxmlformats-officedocument.drawingml.diagramColors+xml\":\"TODO\",\"application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml\":\"TODO\",\"application/vnd.openxmlformats-officedocument.drawingml.diagramLayout+xml\":\"TODO\",\"application/vnd.openxmlformats-officedocument.drawingml.diagramStyle+xml\":\"TODO\",\"application/vnd.openxmlformats-officedocument.vmlDrawing\":\"TODO\",\"application/vnd.openxmlformats-package.relationships+xml\":\"rels\",\"application/vnd.openxmlformats-officedocument.oleObject\":\"TODO\",\"image/png\":\"TODO\",sheet:\"js\"};var Nn={workbooks:{xlsx:\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\",xlsm:\"application/vnd.ms-excel.sheet.macroEnabled.main+xml\",xlsb:\"application/vnd.ms-excel.sheet.binary.macroEnabled.main\",xlam:\"application/vnd.ms-excel.addin.macroEnabled.main+xml\",xltx:\"application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml\"},strs:{xlsx:\"application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml\",xlsb:\"application/vnd.ms-excel.sharedStrings\"},comments:{xlsx:\"application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml\",xlsb:\"application/vnd.ms-excel.comments\"},sheets:{xlsx:\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\",xlsb:\"application/vnd.ms-excel.worksheet\"},charts:{xlsx:\"application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml\",xlsb:\"application/vnd.ms-excel.chartsheet\"},dialogs:{xlsx:\"application/vnd.openxmlformats-officedocument.spreadsheetml.dialogsheet+xml\",xlsb:\"application/vnd.ms-excel.dialogsheet\"},macros:{xlsx:\"application/vnd.ms-excel.macrosheet+xml\",xlsb:\"application/vnd.ms-excel.macrosheet\"},metadata:{xlsx:\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml\",xlsb:\"application/vnd.ms-excel.sheetMetadata\"},styles:{xlsx:\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\",xlsb:\"application/vnd.ms-excel.styles\"}};function Mn(){return{workbooks:[],sheets:[],charts:[],dialogs:[],macros:[],rels:[],strs:[],comments:[],threadedcomments:[],links:[],coreprops:[],extprops:[],custprops:[],themes:[],styles:[],calcchains:[],vba:[],drawings:[],metadata:[],people:[],TODO:[],xmlns:\"\"}}function In(e){var r=Mn();if(!e||!e.match)return r;var t={};(e.match(lt)||[]).forEach(function(e){var a=ft(e);switch(a[0].replace(ot,\"<\")){case\"<?xml\":break;case\"<Types\":r.xmlns=a[\"xmlns\"+(a[0].match(/<(\\w+):/)||[\"\",\"\"])[1]];break;case\"<Default\":t[a.Extension.toLowerCase()]=a.ContentType;break;case\"<Override\":if(r[On[a.ContentType]]!==undefined)r[On[a.ContentType]].push(a.PartName);break;}});if(r.xmlns!==Ht.CT)throw new Error(\"Unknown Namespace: \"+r.xmlns);r.calcchain=r.calcchains.length>0?r.calcchains[0]:\"\";r.sst=r.strs.length>0?r.strs[0]:\"\";r.style=r.styles.length>0?r.styles[0]:\"\";r.defaults=t;delete r.calcchains;return r}function Pn(e,r,t){var a=cr(On);var n=[],i;if(!t){n[n.length]=at;n[n.length]=Bt(\"Types\",null,{xmlns:Ht.CT,\"xmlns:xsd\":Ht.xsd,\"xmlns:xsi\":Ht.xsi});n=n.concat([[\"xml\",\"application/xml\"],[\"bin\",\"application/vnd.ms-excel.sheet.binary.macroEnabled.main\"],[\"vml\",\"application/vnd.openxmlformats-officedocument.vmlDrawing\"],[\"data\",\"application/vnd.openxmlformats-officedocument.model+data\"],[\"bmp\",\"image/bmp\"],[\"png\",\"image/png\"],[\"gif\",\"image/gif\"],[\"emf\",\"image/x-emf\"],[\"wmf\",\"image/x-wmf\"],[\"jpg\",\"image/jpeg\"],[\"jpeg\",\"image/jpeg\"],[\"tif\",\"image/tiff\"],[\"tiff\",\"image/tiff\"],[\"pdf\",\"application/pdf\"],[\"rels\",\"application/vnd.openxmlformats-package.relationships+xml\"]].map(function(e){return Bt(\"Default\",null,{Extension:e[0],ContentType:e[1]})}))}var s=function(t){if(e[t]&&e[t].length>0){i=e[t][0];n[n.length]=Bt(\"Override\",null,{PartName:(i[0]==\"/\"?\"\":\"/\")+i,ContentType:Nn[t][r.bookType]||Nn[t][\"xlsx\"]})}};var l=function(t){(e[t]||[]).forEach(function(e){n[n.length]=Bt(\"Override\",null,{PartName:(e[0]==\"/\"?\"\":\"/\")+e,ContentType:Nn[t][r.bookType]||Nn[t][\"xlsx\"]})})};var o=function(r){(e[r]||[]).forEach(function(e){n[n.length]=Bt(\"Override\",null,{PartName:(e[0]==\"/\"?\"\":\"/\")+e,ContentType:a[r][0]})})};s(\"workbooks\");l(\"sheets\");l(\"charts\");o(\"themes\");[\"strs\",\"styles\"].forEach(s);[\"coreprops\",\"extprops\",\"custprops\"].forEach(o);o(\"vba\");o(\"comments\");o(\"threadedcomments\");o(\"drawings\");l(\"metadata\");o(\"people\");if(!t&&n.length>2){n[n.length]=\"</Types>\";n[1]=n[1].replace(\"/>\",\">\")}return n.join(\"\")}var Rn={WB:\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\",SHEET:\"http://sheetjs.openxmlformats.org/officeDocument/2006/relationships/officeDocument\",HLINK:\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink\",VML:\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing\",XPATH:\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath\",XMISS:\"http://schemas.microsoft.com/office/2006/relationships/xlExternalLinkPath/xlPathMissing\",XLINK:\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink\",CXML:\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml\",CXMLP:\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps\",CMNT:\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments\",CORE_PROPS:\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\",EXT_PROPS:\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties\",CUST_PROPS:\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties\",SST:\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings\",STY:\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\",THEME:\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme\",CHART:\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart\",CHARTEX:\"http://schemas.microsoft.com/office/2014/relationships/chartEx\",CS:\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet\",WS:[\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\",\"http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet\"],DS:\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/dialogsheet\",MS:\"http://schemas.microsoft.com/office/2006/relationships/xlMacrosheet\",IMG:\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\",DRAW:\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing\",XLMETA:\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/sheetMetadata\",TCMNT:\"http://schemas.microsoft.com/office/2017/10/relationships/threadedComment\",PEOPLE:\"http://schemas.microsoft.com/office/2017/10/relationships/person\",CONN:\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/connections\",VBA:\"http://schemas.microsoft.com/office/2006/relationships/vbaProject\"};function Ln(e){var r=e.lastIndexOf(\"/\");return e.slice(0,r+1)+\"_rels/\"+e.slice(r+1)+\".rels\"}function Un(e,r){var t={\"!id\":{}};if(!e)return t;if(r.charAt(0)!==\"/\"){r=\"/\"+r}var a={};(e.match(lt)||[]).forEach(function(e){var n=ft(e);if(n[0]===\"<Relationship\"){var i={};i.Type=n.Type;i.Target=mt(n.Target);i.Id=n.Id;if(n.TargetMode)i.TargetMode=n.TargetMode;var s=n.TargetMode===\"External\"?n.Target:tt(n.Target,r);t[s]=i;a[n.Id]=i}});t[\"!id\"]=a;return t}function Bn(e){var r=[at,Bt(\"Relationships\",null,{xmlns:Ht.RELS})];ir(e[\"!id\"]).forEach(function(t){r[r.length]=Bt(\"Relationship\",null,e[\"!id\"][t])});if(r.length>2){r[r.length]=\"</Relationships>\";r[1]=r[1].replace(\"/>\",\">\")}return r.join(\"\")}function zn(e,r,t,a,n,i){if(!n)n={};if(!e[\"!id\"])e[\"!id\"]={};if(!e[\"!idx\"])e[\"!idx\"]=1;if(r<0)for(r=e[\"!idx\"];e[\"!id\"][\"rId\"+r];++r){}e[\"!idx\"]=r+1;n.Id=\"rId\"+r;n.Type=a;n.Target=t;if(i)n.TargetMode=i;else if([Rn.HLINK,Rn.XPATH,Rn.XMISS].indexOf(n.Type)>-1)n.TargetMode=\"External\";if(e[\"!id\"][n.Id])throw new Error(\"Cannot rewrite rId \"+r);e[\"!id\"][n.Id]=n;e[(\"/\"+n.Target).replace(\"//\",\"/\")]=n;return r}var $n=\"application/vnd.oasis.opendocument.spreadsheet\";function Wn(e,r){var t=Wt(e);var a;var n;while(a=jt.exec(t))switch(a[3]){case\"manifest\":break;case\"file-entry\":n=ft(a[0],false);if(n.path==\"/\"&&n.type!==$n)throw new Error(\"This OpenDocument is not a spreadsheet\");break;case\"encryption-data\":;case\"algorithm\":;case\"start-key-generation\":;case\"key-derivation\":throw new Error(\"Unsupported ODS Encryption\");default:if(r&&r.WTF)throw a;}}function jn(e){var r=[at];r.push('<manifest:manifest xmlns:manifest=\"urn:oasis:names:tc:opendocument:xmlns:manifest:1.0\" manifest:version=\"1.2\">\\n');r.push('  <manifest:file-entry manifest:full-path=\"/\" manifest:version=\"1.2\" manifest:media-type=\"application/vnd.oasis.opendocument.spreadsheet\"/>\\n');for(var t=0;t<e.length;++t)r.push('  <manifest:file-entry manifest:full-path=\"'+e[t][0]+'\" manifest:media-type=\"'+e[t][1]+'\"/>\\n');r.push(\"</manifest:manifest>\");return r.join(\"\")}function Hn(e,r,t){return['  <rdf:Description rdf:about=\"'+e+'\">\\n','    <rdf:type rdf:resource=\"http://docs.oasis-open.org/ns/office/1.2/meta/'+(t||\"odf\")+\"#\"+r+'\"/>\\n',\"  </rdf:Description>\\n\"].join(\"\")}function Vn(e,r){return['  <rdf:Description rdf:about=\"'+e+'\">\\n','    <ns0:hasPart xmlns:ns0=\"http://docs.oasis-open.org/ns/office/1.2/meta/pkg#\" rdf:resource=\"'+r+'\"/>\\n',\"  </rdf:Description>\\n\"].join(\"\")}function Xn(e){var r=[at];r.push('<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\\n');for(var t=0;t!=e.length;++t){r.push(Hn(e[t][0],e[t][1]));r.push(Vn(\"\",e[t][0]))}r.push(Hn(\"\",\"Document\",\"pkg\"));r.push(\"</rdf:RDF>\");return r.join(\"\")}function Gn(r,t){return'<office:document-meta xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\" xmlns:meta=\"urn:oasis:names:tc:opendocument:xmlns:meta:1.0\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" office:version=\"1.2\"><office:meta><meta:generator>SheetJS '+e.version+\"</meta:generator></office:meta></office:document-meta>\"}var Yn=[[\"cp:category\",\"Category\"],[\"cp:contentStatus\",\"ContentStatus\"],[\"cp:keywords\",\"Keywords\"],[\"cp:lastModifiedBy\",\"LastAuthor\"],[\"cp:lastPrinted\",\"LastPrinted\"],[\"cp:revision\",\"RevNumber\"],[\"cp:version\",\"Version\"],[\"dc:creator\",\"Author\"],[\"dc:description\",\"Comments\"],[\"dc:identifier\",\"Identifier\"],[\"dc:language\",\"Language\"],[\"dc:subject\",\"Subject\"],[\"dc:title\",\"Title\"],[\"dcterms:created\",\"CreatedDate\",\"date\"],[\"dcterms:modified\",\"ModifiedDate\",\"date\"]];function Jn(e){var r={};e=Dt(e);for(var t=0;t<Yn.length;++t){var a=Yn[t],n=Br(e,a[0]);if(n!=null&&n.length>0)r[a[1]]=mt(n[1]);if(a[2]===\"date\"&&r[a[1]])r[a[1]]=wr(r[a[1]])}return r}function Zn(e,r,t,a,n){if(n[e]!=null||r==null||r===\"\")return;n[e]=r;r=bt(r);a[a.length]=t?Bt(e,r,t):Lt(e,r)}function Kn(e,r){var t=r||{};var a=[at,Bt(\"cp:coreProperties\",null,{\"xmlns:cp\":Ht.CORE_PROPS,\"xmlns:dc\":Ht.dc,\"xmlns:dcterms\":Ht.dcterms,\"xmlns:dcmitype\":Ht.dcmitype,\"xmlns:xsi\":Ht.xsi})],n={};if(!e&&!t.Props)return a.join(\"\");if(e){if(e.CreatedDate!=null)Zn(\"dcterms:created\",typeof e.CreatedDate===\"string\"?e.CreatedDate:zt(e.CreatedDate,t.WTF),{\"xsi:type\":\"dcterms:W3CDTF\"},a,n);if(e.ModifiedDate!=null)Zn(\"dcterms:modified\",typeof e.ModifiedDate===\"string\"?e.ModifiedDate:zt(e.ModifiedDate,t.WTF),{\"xsi:type\":\"dcterms:W3CDTF\"},a,n)}for(var i=0;i!=Yn.length;++i){var s=Yn[i];var l=t.Props&&t.Props[s[1]]!=null?t.Props[s[1]]:e?e[s[1]]:null;if(l===true)l=\"1\";else if(l===false)l=\"0\";else if(typeof l==\"number\")l=String(l);if(l!=null)Zn(s[0],l,null,a,n)}if(a.length>2){a[a.length]=\"</cp:coreProperties>\";a[1]=a[1].replace(\"/>\",\">\")}return a.join(\"\")}var qn=[[\"Application\",\"Application\",\"string\"],[\"AppVersion\",\"AppVersion\",\"string\"],[\"Company\",\"Company\",\"string\"],[\"DocSecurity\",\"DocSecurity\",\"string\"],[\"Manager\",\"Manager\",\"string\"],[\"HyperlinksChanged\",\"HyperlinksChanged\",\"bool\"],[\"SharedDoc\",\"SharedDoc\",\"bool\"],[\"LinksUpToDate\",\"LinksUpToDate\",\"bool\"],[\"ScaleCrop\",\"ScaleCrop\",\"bool\"],[\"HeadingPairs\",\"HeadingPairs\",\"raw\"],[\"TitlesOfParts\",\"TitlesOfParts\",\"raw\"]];var Qn=[\"Worksheets\",\"SheetNames\",\"NamedRanges\",\"DefinedNames\",\"Chartsheets\",\"ChartNames\"];function ei(e,r,t,a){var n=[];if(typeof e==\"string\")n=Pt(e,a);else for(var i=0;i<e.length;++i)n=n.concat(e[i].map(function(e){return{v:e}}));var s=typeof r==\"string\"?Pt(r,a).map(function(e){return e.v}):r;var l=0,o=0;if(s.length>0)for(var c=0;c!==n.length;c+=2){o=+n[c+1].v;switch(n[c].v){case\"Worksheets\":;case\"工作表\":;case\"Листы\":;case\"أوراق العمل\":;case\"ワークシート\":;case\"גליונות עבודה\":;case\"Arbeitsblätter\":;case\"Çalışma Sayfaları\":;case\"Feuilles de calcul\":;case\"Fogli di lavoro\":;case\"Folhas de cálculo\":;case\"Planilhas\":;case\"Regneark\":;case\"Hojas de cálculo\":;case\"Werkbladen\":t.Worksheets=o;t.SheetNames=s.slice(l,l+o);break;case\"Named Ranges\":;case\"Rangos con nombre\":;case\"名前付き一覧\":;case\"Benannte Bereiche\":;case\"Navngivne områder\":t.NamedRanges=o;t.DefinedNames=s.slice(l,l+o);break;case\"Charts\":;case\"Diagramme\":t.Chartsheets=o;t.ChartNames=s.slice(l,l+o);break;}l+=o}}function ri(e,r,t){var a={};if(!r)r={};e=Dt(e);qn.forEach(function(t){var n=(zr(e,t[0])||[])[1];switch(t[2]){case\"string\":if(n)r[t[1]]=mt(n);break;case\"bool\":r[t[1]]=n===\"true\";break;case\"raw\":var i=Br(e,t[0]);if(i&&i.length>0)a[t[1]]=i[1];break;}});if(a.HeadingPairs&&a.TitlesOfParts)ei(a.HeadingPairs,a.TitlesOfParts,r,t);return r}function ti(e){var r=[],t=Bt;if(!e)e={};e.Application=\"SheetJS\";r[r.length]=at;r[r.length]=Bt(\"Properties\",null,{xmlns:Ht.EXT_PROPS,\"xmlns:vt\":Ht.vt});qn.forEach(function(a){if(e[a[1]]===undefined)return;var n;switch(a[2]){case\"string\":n=bt(String(e[a[1]]));break;case\"bool\":n=e[a[1]]?\"true\":\"false\";break;}if(n!==undefined)r[r.length]=t(a[0],n)});r[r.length]=t(\"HeadingPairs\",t(\"vt:vector\",t(\"vt:variant\",\"<vt:lpstr>Worksheets</vt:lpstr>\")+t(\"vt:variant\",t(\"vt:i4\",String(e.Worksheets))),{size:2,baseType:\"variant\"}));r[r.length]=t(\"TitlesOfParts\",t(\"vt:vector\",e.SheetNames.map(function(e){return\"<vt:lpstr>\"+bt(e)+\"</vt:lpstr>\"}).join(\"\"),{size:e.Worksheets,baseType:\"lpstr\"}));if(r.length>2){r[r.length]=\"</Properties>\";r[1]=r[1].replace(\"/>\",\">\")}return r.join(\"\")}var ai=/<[^<>]+>[^<]*/g;function ni(e,r){var t={},a=\"\";var n=e.match(ai);if(n)for(var i=0;i!=n.length;++i){var s=n[i],l=ft(s);switch(ht(l[0])){case\"<?xml\":break;case\"<Properties\":break;case\"<property\":a=mt(l.name);break;case\"</property>\":a=null;break;default:if(s.indexOf(\"<vt:\")===0){var o=s.split(\">\");var c=o[0].slice(4),f=o[1];switch(c){case\"lpstr\":;case\"bstr\":;case\"lpwstr\":t[a]=mt(f);break;case\"bool\":t[a]=_t(f);break;case\"i1\":;case\"i2\":;case\"i4\":;case\"i8\":;case\"int\":;case\"uint\":t[a]=parseInt(f,10);break;case\"r4\":;case\"r8\":;case\"decimal\":t[a]=parseFloat(f);break;case\"filetime\":;case\"date\":t[a]=wr(f);break;case\"cy\":;case\"error\":t[a]=mt(f);break;default:if(c.slice(-1)==\"/\")break;if(r.WTF&&typeof console!==\"undefined\")console.warn(\"Unexpected\",s,c,o);}}else if(s.slice(0,2)===\"</\"){}else if(r.WTF)throw new Error(s);}}return t}function ii(e){var r=[at,Bt(\"Properties\",null,{xmlns:Ht.CUST_PROPS,\"xmlns:vt\":Ht.vt})];if(!e)return r.join(\"\");var t=1;ir(e).forEach(function a(n){++t;r[r.length]=Bt(\"property\",$t(e[n],true),{fmtid:\"{D5CDD505-2E9C-101B-9397-08002B2CF9AE}\",pid:t,name:bt(n)})});if(r.length>2){r[r.length]=\"</Properties>\";r[1]=r[1].replace(\"/>\",\">\")}return r.join(\"\")}var si=[2,3,48,49,131,139,140,245];var li=function(){var e={1:437,2:850,3:1252,4:1e4,100:852,101:866,102:865,103:861,104:895,105:620,106:737,107:857,120:950,121:949,122:936,123:932,124:874,125:1255,126:1256,150:10007,151:10029,152:10006,200:1250,201:1251,202:1254,203:1253,0:20127,8:865,9:437,10:850,11:437,13:437,14:850,15:437,16:850,17:437,18:850,19:932,20:850,21:437,22:850,23:865,24:437,25:437,26:850,27:437,28:863,29:850,31:852,34:852,35:852,36:860,37:850,38:866,55:850,64:852,77:936,78:949,79:950,80:874,87:1252,88:1252,89:1252,108:863,134:737,135:852,136:857,204:1257,255:16969};var n=lr({1:437,2:850,3:1252,4:1e4,100:852,101:866,102:865,103:861,104:895,105:620,106:737,107:857,120:950,121:949,122:936,123:932,124:874,125:1255,126:1256,150:10007,151:10029,152:10006,200:1250,201:1251,202:1254,203:1253,0:20127});function i(r,t){var n=[];var i=E(1);switch(t.type){case\"base64\":i=D(S(r));break;case\"binary\":i=D(r);break;case\"buffer\":;case\"array\":i=r;break;}Fa(i,0);var s=i._R(1);var l=!!(s&136);var o=false,c=false;switch(s){case 2:break;case 3:break;case 48:o=true;l=true;break;case 49:o=true;l=true;break;case 131:break;case 139:break;case 140:c=true;break;case 245:break;default:throw new Error(\"DBF Unsupported Version: \"+s.toString(16));}var f=0,u=521;if(s==2)f=i._R(2);i.l+=3;if(s!=2)f=i._R(4);if(f>1048576)f=1e6;if(s!=2)u=i._R(2);var h=i._R(2);var d=t.codepage||1252;if(s!=2){i.l+=16;i._R(1);if(i[i.l]!==0)d=e[i[i.l]];i.l+=1;i.l+=2}if(c)i.l+=36;var p=[],m={};var v=Math.min(i.length,s==2?521:u-10-(o?264:0));var g=c?32:11;while(i.l<v&&i[i.l]!=13){m={};m.name=(typeof a!==\"undefined\"?a.utils.decode(d,i.slice(i.l,i.l+g)):N(i.slice(i.l,i.l+g))).replace(/[\\u0000\\r\\n][\\S\\s]*$/g,\"\");i.l+=g;m.type=String.fromCharCode(i._R(1));if(s!=2&&!c)m.offset=i._R(4);m.len=i._R(1);if(s==2)m.offset=i._R(2);m.dec=i._R(1);if(m.name.length)p.push(m);if(s!=2)i.l+=c?13:14;switch(m.type){case\"B\":if((!o||m.len!=8)&&t.WTF)console.log(\"Skipping \"+m.name+\":\"+m.type);break;case\"G\":;case\"P\":if(t.WTF)console.log(\"Skipping \"+m.name+\":\"+m.type);break;case\"+\":;case\"0\":;case\"@\":;case\"C\":;case\"D\":;case\"F\":;case\"I\":;case\"L\":;case\"M\":;case\"N\":;case\"O\":;case\"T\":;case\"Y\":break;default:throw new Error(\"Unknown Field Type: \"+m.type);}}if(i[i.l]!==13)i.l=u-1;if(i._R(1)!==13)throw new Error(\"DBF Terminator not found \"+i.l+\" \"+i[i.l]);i.l=u;var b=0,w=0;n[0]=[];for(w=0;w!=p.length;++w)n[0][w]=p[w].name;while(f-- >0){if(i[i.l]===42){i.l+=h;continue}++i.l;n[++b]=[];w=0;for(w=0;w!=p.length;++w){var k=i.slice(i.l,i.l+p[w].len);i.l+=p[w].len;Fa(k,0);var y=typeof a!==\"undefined\"?a.utils.decode(d,k):N(k);switch(p[w].type){case\"C\":if(y.trim().length)n[b][w]=y.replace(/([^\\s])\\s+$/,\"$1\");break;case\"D\":if(y.length===8){n[b][w]=new Date(Date.UTC(+y.slice(0,4),+y.slice(4,6)-1,+y.slice(6,8),0,0,0,0));if(!(t&&t.UTC)){n[b][w]=Mr(n[b][w])}}else n[b][w]=y;break;case\"F\":n[b][w]=parseFloat(y.trim());break;case\"+\":;case\"I\":n[b][w]=c?k._R(-4,\"i\")^2147483648:k._R(4,\"i\");break;case\"L\":switch(y.trim().toUpperCase()){case\"Y\":;case\"T\":n[b][w]=true;break;case\"N\":;case\"F\":n[b][w]=false;break;case\"\":;case\"\\0\":;case\"?\":break;default:throw new Error(\"DBF Unrecognized L:|\"+y+\"|\");}break;case\"M\":if(!l)throw new Error(\"DBF Unexpected MEMO for type \"+s.toString(16));n[b][w]=\"##MEMO##\"+(c?parseInt(y.trim(),10):k._R(4));break;case\"N\":y=y.replace(/\\u0000/g,\"\").trim();if(y&&y!=\".\")n[b][w]=+y||0;break;case\"@\":n[b][w]=new Date(k._R(-8,\"f\")-621356832e5);break;case\"T\":{var x=k._R(4),C=k._R(4);if(x==0&&C==0)break;n[b][w]=new Date((x-2440588)*864e5+C);if(!(t&&t.UTC))n[b][w]=Mr(n[b][w])}break;case\"Y\":n[b][w]=k._R(4,\"i\")/1e4+k._R(4,\"i\")/1e4*Math.pow(2,32);break;case\"O\":n[b][w]=-k._R(-8,\"f\");break;case\"B\":if(o&&p[w].len==8){n[b][w]=k._R(8,\"f\");break};case\"G\":;case\"P\":k.l+=p[w].len;break;case\"0\":if(p[w].name===\"_NullFlags\")break;default:throw new Error(\"DBF Unsupported data type \"+p[w].type);}}}if(s!=2)if(i.l<i.length&&i[i.l++]!=26)throw new Error(\"DBF EOF Marker missing \"+(i.l-1)+\" of \"+i.length+\" \"+i[i.l-1].toString(16));if(t&&t.sheetRows)n=n.slice(0,t.sheetRows);t.DBF=p;return n}function s(e,r){var t=r||{};if(!t.dateNF)t.dateNF=\"yyyymmdd\";var a=ln(i(e,t),t);a[\"!cols\"]=t.DBF.map(function(e){return{wch:e.len,DBF:e}});delete t.DBF;return a}function l(e,r){try{var t=an(s(e,r),r);t.bookType=\"dbf\";return t}catch(a){if(r&&r.WTF)throw a}return{SheetNames:[],Sheets:{}}}var c={B:8,C:250,L:1,D:8,\"?\":0,\"\":0};function f(i,s){if(!i[\"!ref\"])throw new Error(\"Cannot export empty sheet to DBF\");var l=s||{};var f=r;if(+l.codepage>=0)o(+l.codepage);if(l.type==\"string\")throw new Error(\"Cannot write DBF to JS string\");var u=Ma();var h=fc(i,{header:1,raw:true,cellDates:true});var d=h[0],p=h.slice(1),m=i[\"!cols\"]||[];var v=0,g=0,b=0,w=1;for(v=0;v<d.length;++v){if(((m[v]||{}).DBF||{}).name){d[v]=m[v].DBF.name;++b;continue}if(d[v]==null)continue;++b;if(typeof d[v]===\"number\")d[v]=d[v].toString(10);if(typeof d[v]!==\"string\")throw new Error(\"DBF Invalid column name \"+d[v]+\" |\"+typeof d[v]+\"|\");if(d.indexOf(d[v])!==v)for(g=0;g<1024;++g)if(d.indexOf(d[v]+\"_\"+g)==-1){d[v]+=\"_\"+g;break}}var k=en(i[\"!ref\"]);var y=[];var x=[];var C=[];for(v=0;v<=k.e.c-k.s.c;++v){var S=\"\",_=\"\",A=0;var T=[];for(g=0;g<p.length;++g){if(p[g][v]!=null)T.push(p[g][v])}if(T.length==0||d[v]==null){y[v]=\"?\";continue}for(g=0;g<T.length;++g){switch(typeof T[g]){case\"number\":_=\"B\";break;case\"string\":_=\"C\";break;case\"boolean\":_=\"L\";break;case\"object\":_=T[g]instanceof Date?\"D\":\"C\";break;default:_=\"C\";}A=Math.max(A,(typeof a!==\"undefined\"&&typeof T[g]==\"string\"?a.utils.encode(t,T[g]):String(T[g])).length);S=S&&S!=_?\"C\":_}if(A>250)A=250;_=((m[v]||{}).DBF||{}).type;if(_==\"C\"){if(m[v].DBF.len>A)A=m[v].DBF.len}if(S==\"B\"&&_==\"N\"){S=\"N\";C[v]=m[v].DBF.dec;A=m[v].DBF.len}x[v]=S==\"C\"||_==\"N\"?A:c[S]||0;w+=x[v];y[v]=S}var E=u.next(32);E._W(4,318902576);E._W(4,p.length);E._W(2,296+32*b);E._W(2,w);for(v=0;v<4;++v)E._W(4,0);var F=+n[r]||3;E._W(4,0|F<<8);if(e[F]!=+l.codepage){if(l.codepage)console.error(\"DBF Unsupported codepage \"+r+\", using 1252\");\nr=1252}for(v=0,g=0;v<d.length;++v){if(d[v]==null)continue;var D=u.next(32);var O=(d[v].slice(-10)+\"\\0\\0\\0\\0\\0\\0\\0\\0\\0\\0\\0\").slice(0,11);D._W(1,O,\"sbcs\");D._W(1,y[v]==\"?\"?\"C\":y[v],\"sbcs\");D._W(4,g);D._W(1,x[v]||c[y[v]]||0);D._W(1,C[v]||0);D._W(1,2);D._W(4,0);D._W(1,0);D._W(4,0);D._W(4,0);g+=x[v]||c[y[v]]||0}var N=u.next(264);N._W(4,13);for(v=0;v<65;++v)N._W(4,0);for(v=0;v<p.length;++v){var M=u.next(w);M._W(1,0);for(g=0;g<d.length;++g){if(d[g]==null)continue;switch(y[g]){case\"L\":M._W(1,p[v][g]==null?63:p[v][g]?84:70);break;case\"B\":M._W(8,p[v][g]||0,\"f\");break;case\"N\":var I=\"0\";if(typeof p[v][g]==\"number\")I=p[v][g].toFixed(C[g]||0);if(I.length>x[g])I=I.slice(0,x[g]);for(b=0;b<x[g]-I.length;++b)M._W(1,32);M._W(1,I,\"sbcs\");break;case\"D\":if(!p[v][g])M._W(8,\"00000000\",\"sbcs\");else{M._W(4,(\"0000\"+p[v][g].getFullYear()).slice(-4),\"sbcs\");M._W(2,(\"00\"+(p[v][g].getMonth()+1)).slice(-2),\"sbcs\");M._W(2,(\"00\"+p[v][g].getDate()).slice(-2),\"sbcs\")}break;case\"C\":var P=M.l;var R=String(p[v][g]!=null?p[v][g]:\"\").slice(0,x[g]);M._W(1,R,\"cpstr\");P+=x[g]-M.l;for(b=0;b<P;++b)M._W(1,32);break;}}}r=f;u.next(1)._W(1,26);return u.end()}return{to_workbook:l,to_sheet:s,from_sheet:f}}();var oi=function(){var e={AA:\"À\",BA:\"Á\",CA:\"Â\",DA:195,HA:\"Ä\",JA:197,AE:\"È\",BE:\"É\",CE:\"Ê\",HE:\"Ë\",AI:\"Ì\",BI:\"Í\",CI:\"Î\",HI:\"Ï\",AO:\"Ò\",BO:\"Ó\",CO:\"Ô\",DO:213,HO:\"Ö\",AU:\"Ù\",BU:\"Ú\",CU:\"Û\",HU:\"Ü\",Aa:\"à\",Ba:\"á\",Ca:\"â\",Da:227,Ha:\"ä\",Ja:229,Ae:\"è\",Be:\"é\",Ce:\"ê\",He:\"ë\",Ai:\"ì\",Bi:\"í\",Ci:\"î\",Hi:\"ï\",Ao:\"ò\",Bo:\"ó\",Co:\"ô\",Do:245,Ho:\"ö\",Au:\"ù\",Bu:\"ú\",Cu:\"û\",Hu:\"ü\",KC:\"Ç\",Kc:\"ç\",q:\"æ\",z:\"œ\",a:\"Æ\",j:\"Œ\",DN:209,Dn:241,Hy:255,S:169,c:170,R:174,\"B \":180,0:176,1:177,2:178,3:179,5:181,6:182,7:183,Q:185,k:186,b:208,i:216,l:222,s:240,y:248,\"!\":161,'\"':162,\"#\":163,\"(\":164,\"%\":165,\"'\":167,\"H \":168,\"+\":171,\";\":187,\"<\":188,\"=\":189,\">\":190,\"?\":191,\"{\":223};var r=new RegExp(\"\u001bN(\"+ir(e).join(\"|\").replace(/\\|\\|\\|/,\"|\\\\||\").replace(/([?()+])/g,\"\\\\$1\").replace(\"{\",\"\\\\{\")+\"|\\\\|)\",\"gm\");try{r=new RegExp(\"\u001bN(\"+ir(e).join(\"|\").replace(/\\|\\|\\|/,\"|\\\\||\").replace(/([?()+])/g,\"\\\\$1\")+\"|\\\\|)\",\"gm\")}catch(t){}var n=function(r,t){var a=e[t];return typeof a==\"number\"?v(a):a};var i=function(e,r,t){var a=r.charCodeAt(0)-32<<4|t.charCodeAt(0)-48;return a==59?e:v(a)};e[\"|\"]=254;var s=function(e){return e.replace(/\\n/g,\"\u001b :\").replace(/\\r/g,\"\u001b =\")};function l(e,r){switch(r.type){case\"base64\":return c(S(e),r);case\"binary\":return c(e,r);case\"buffer\":return c(_&&Buffer.isBuffer(e)?e.toString(\"binary\"):N(e),r);case\"array\":return c(kr(e),r);}throw new Error(\"Unrecognized type \"+r.type)}function c(e,t){var s=e.split(/[\\n\\r]+/),l=-1,c=-1,f=0,u=0,h=[];var d=[];var p=null;var m={},v=[],g=[],b=[];var w=0,k;var y={Workbook:{WBProps:{},Names:[]}};if(+t.codepage>=0)o(+t.codepage);for(;f!==s.length;++f){w=0;var x=s[f].trim().replace(/\\x1B([\\x20-\\x2F])([\\x30-\\x3F])/g,i).replace(r,n);var C=x.replace(/;;/g,\"\\0\").split(\";\").map(function(e){return e.replace(/\\u0000/g,\";\")});var S=C[0],_;if(x.length>0)switch(S){case\"ID\":break;case\"E\":break;case\"B\":break;case\"O\":for(u=1;u<C.length;++u)switch(C[u].charAt(0)){case\"V\":{var A=parseInt(C[u].slice(1),10);if(A>=1&&A<=4)y.Workbook.WBProps.date1904=true}break;}break;case\"W\":break;case\"P\":switch(C[1].charAt(0)){case\"P\":d.push(x.slice(3).replace(/;;/g,\";\"));break;}break;case\"NN\":{var T={Sheet:0};for(u=1;u<C.length;++u)switch(C[u].charAt(0)){case\"N\":T.Name=C[u].slice(1);break;case\"E\":T.Ref=(t&&t.sheet||\"Sheet1\")+\"!\"+Os(C[u].slice(1));break;}y.Workbook.Names.push(T)}break;case\"C\":var E=false,F=false,D=false,O=false,N=-1,M=-1,I=\"\",P=\"z\";var R=\"\";for(u=1;u<C.length;++u)switch(C[u].charAt(0)){case\"A\":R=C[u].slice(1);break;case\"X\":c=parseInt(C[u].slice(1),10)-1;F=true;break;case\"Y\":l=parseInt(C[u].slice(1),10)-1;if(!F)c=0;for(k=h.length;k<=l;++k)h[k]=[];break;case\"K\":_=C[u].slice(1);if(_.charAt(0)==='\"'){_=_.slice(1,_.length-1);P=\"s\"}else if(_===\"TRUE\"||_===\"FALSE\"){_=_===\"TRUE\";P=\"b\"}else if(_.charAt(0)==\"#\"&&Fn[_]!=null){P=\"e\";_=Fn[_]}else if(!isNaN(Cr(_))){_=Cr(_);P=\"n\";if(p!==null&&Re(p)&&t.cellDates){_=pr(y.Workbook.WBProps.date1904?_+1462:_);P=typeof _==\"number\"?\"n\":\"d\"}}if(typeof a!==\"undefined\"&&typeof _==\"string\"&&(t||{}).type!=\"string\"&&(t||{}).codepage)_=a.utils.decode(t.codepage,_);E=true;break;case\"E\":O=true;I=Os(C[u].slice(1),{r:l,c:c});break;case\"S\":D=true;break;case\"G\":break;case\"R\":N=parseInt(C[u].slice(1),10)-1;break;case\"C\":M=parseInt(C[u].slice(1),10)-1;break;default:if(t&&t.WTF)throw new Error(\"SYLK bad record \"+x);}if(E){if(!h[l][c])h[l][c]={t:P,v:_};else{h[l][c].t=P;h[l][c].v=_}if(p)h[l][c].z=p;if(t.cellText!==false&&p)h[l][c].w=$e(h[l][c].z,h[l][c].v,{date1904:y.Workbook.WBProps.date1904});p=null}if(D){if(O)throw new Error(\"SYLK shared formula cannot have own formula\");var L=N>-1&&h[N][M];if(!L||!L[1])throw new Error(\"SYLK shared formula cannot find base\");I=Ps(L[1],{r:l-N,c:c-M})}if(I){if(!h[l][c])h[l][c]={t:\"n\",f:I};else h[l][c].f=I}if(R){if(!h[l][c])h[l][c]={t:\"z\"};h[l][c].c=[{a:\"SheetJSYLK\",t:R}]}break;case\"F\":var U=0;for(u=1;u<C.length;++u)switch(C[u].charAt(0)){case\"X\":c=parseInt(C[u].slice(1),10)-1;++U;break;case\"Y\":l=parseInt(C[u].slice(1),10)-1;for(k=h.length;k<=l;++k)h[k]=[];break;case\"M\":w=parseInt(C[u].slice(1),10)/20;break;case\"F\":break;case\"G\":break;case\"P\":p=d[parseInt(C[u].slice(1),10)];break;case\"S\":break;case\"D\":break;case\"N\":break;case\"W\":b=C[u].slice(1).split(\" \");for(k=parseInt(b[0],10);k<=parseInt(b[1],10);++k){w=parseInt(b[2],10);g[k-1]=w===0?{hidden:true}:{wch:w}}break;case\"C\":c=parseInt(C[u].slice(1),10)-1;if(!g[c])g[c]={};break;case\"R\":l=parseInt(C[u].slice(1),10)-1;if(!v[l])v[l]={};if(w>0){v[l].hpt=w;v[l].hpx=Wi(w)}else if(w===0)v[l].hidden=true;break;default:if(t&&t.WTF)throw new Error(\"SYLK bad record \"+x);}if(U<1)p=null;break;default:if(t&&t.WTF)throw new Error(\"SYLK bad record \"+x);}}if(v.length>0)m[\"!rows\"]=v;if(g.length>0)m[\"!cols\"]=g;g.forEach(function(e){Ui(e)});if(t&&t.sheetRows)h=h.slice(0,t.sheetRows);return[h,m,y]}function f(e,r){var t=l(e,r);var a=t[0],n=t[1],i=t[2];var s=yr(r);s.date1904=(((i||{}).Workbook||{}).WBProps||{}).date1904;var o=ln(a,s);ir(n).forEach(function(e){o[e]=n[e]});var c=an(o,r);ir(i).forEach(function(e){c[e]=i[e]});c.bookType=\"sylk\";return c}function u(e,r,t,a,n,i){var s=\"C;Y\"+(t+1)+\";X\"+(a+1)+\";K\";switch(e.t){case\"n\":s+=isFinite(e.v)?e.v||0:En[isNaN(e.v)?36:7];if(e.f&&!e.F)s+=\";E\"+Is(e.f,{r:t,c:a});break;case\"b\":s+=e.v?\"TRUE\":\"FALSE\";break;case\"e\":s+=e.w||En[e.v]||e.v;break;case\"d\":s+=dr(wr(e.v,i),i);break;case\"s\":s+='\"'+(e.v==null?\"\":String(e.v)).replace(/\"/g,\"\").replace(/;/g,\";;\")+'\"';break;}return s}function h(e,r,t){var a=\"C;Y\"+(r+1)+\";X\"+(t+1)+\";A\";a+=s(e.map(function(e){return e.t}).join(\"\"));return a}function d(e,r){r.forEach(function(r,t){var a=\"F;W\"+(t+1)+\" \"+(t+1)+\" \";if(r.hidden)a+=\"0\";else{if(typeof r.width==\"number\"&&!r.wpx)r.wpx=Mi(r.width);if(typeof r.wpx==\"number\"&&!r.wch)r.wch=Ii(r.wpx);if(typeof r.wch==\"number\")a+=Math.round(r.wch)}if(a.charAt(a.length-1)!=\" \")e.push(a)})}function p(e,r){r.forEach(function(r,t){var a=\"F;\";if(r.hidden)a+=\"M0;\";else if(r.hpt)a+=\"M\"+20*r.hpt+\";\";else if(r.hpx)a+=\"M\"+20*$i(r.hpx)+\";\";if(a.length>2)e.push(a+\"R\"+(t+1))})}function m(e,r,t){if(!r)r={};r._formats=[\"General\"];var a=[\"ID;PSheetJS;N;E\"],n=[];var i=en(e[\"!ref\"]||\"A1\"),s;var l=e[\"!data\"]!=null;var o=\"\\r\\n\";var c=(((t||{}).Workbook||{}).WBProps||{}).date1904;var f=\"General\";a.push(\"P;PGeneral\");var m=i.s.r,v=i.s.c,g=[];if(e[\"!ref\"])for(m=i.s.r;m<=i.e.r;++m){if(l&&!e[\"!data\"][m])continue;g=[];for(v=i.s.c;v<=i.e.c;++v){s=l?e[\"!data\"][m][v]:e[Ha(v)+za(m)];if(!s||!s.c)continue;g.push(h(s.c,m,v))}if(g.length)n.push(g.join(o))}if(e[\"!ref\"])for(m=i.s.r;m<=i.e.r;++m){if(l&&!e[\"!data\"][m])continue;g=[];for(v=i.s.c;v<=i.e.c;++v){s=l?e[\"!data\"][m][v]:e[Ha(v)+za(m)];if(!s||s.v==null&&(!s.f||s.F))continue;if((s.z||(s.t==\"d\"?q[14]:\"General\"))!=f){var b=r._formats.indexOf(s.z);if(b==-1){r._formats.push(s.z);b=r._formats.length-1;a.push(\"P;P\"+s.z.replace(/;/g,\";;\"))}g.push(\"F;P\"+b+\";Y\"+(m+1)+\";X\"+(v+1))}g.push(u(s,e,m,v,r,c))}n.push(g.join(o))}a.push(\"F;P0;DG0G8;M255\");if(e[\"!cols\"])d(a,e[\"!cols\"]);if(e[\"!rows\"])p(a,e[\"!rows\"]);if(e[\"!ref\"])a.push(\"B;Y\"+(i.e.r-i.s.r+1)+\";X\"+(i.e.c-i.s.c+1)+\";D\"+[i.s.c,i.s.r,i.e.c,i.e.r].join(\" \"));a.push(\"O;L;D;B\"+(c?\";V4\":\"\")+\";K47;G100 0.001\");delete r._formats;return a.join(o)+o+n.join(o)+o+\"E\"+o}return{to_workbook:f,from_sheet:m}}();var ci=function(){function e(e,t){switch(t.type){case\"base64\":return r(S(e),t);case\"binary\":return r(e,t);case\"buffer\":return r(_&&Buffer.isBuffer(e)?e.toString(\"binary\"):N(e),t);case\"array\":return r(kr(e),t);}throw new Error(\"Unrecognized type \"+t.type)}function r(e,r){var t=e.split(\"\\n\"),a=-1,n=-1,i=0,s=[];for(;i!==t.length;++i){if(t[i].trim()===\"BOT\"){s[++a]=[];n=0;continue}if(a<0)continue;var l=t[i].trim().split(\",\");var o=l[0],c=l[1];++i;var f=t[i]||\"\";while((f.match(/[\"]/g)||[]).length&1&&i<t.length-1)f+=\"\\n\"+t[++i];f=f.trim();switch(+o){case-1:if(f===\"BOT\"){s[++a]=[];n=0;continue}else if(f!==\"EOD\")throw new Error(\"Unrecognized DIF special command \"+f);break;case 0:if(f===\"TRUE\")s[a][n]=true;else if(f===\"FALSE\")s[a][n]=false;else if(!isNaN(Cr(c)))s[a][n]=Cr(c);else if(!isNaN(Or(c).getDate())){s[a][n]=wr(c);if(!(r&&r.UTC)){s[a][n]=Mr(s[a][n])}}else s[a][n]=c;++n;break;case 1:f=f.slice(1,f.length-1);f=f.replace(/\"\"/g,'\"');if(w&&f&&f.match(/^=\".*\"$/))f=f.slice(2,-1);s[a][n++]=f!==\"\"?f:null;break;}if(f===\"EOD\")break}if(r&&r.sheetRows)s=s.slice(0,r.sheetRows);return s}function t(r,t){return ln(e(r,t),t)}function a(e,r){var a=an(t(e,r),r);a.bookType=\"dif\";return a}function n(e,r){return\"0,\"+String(e)+\"\\r\\n\"+r}function i(e){return'1,0\\r\\n\"'+e.replace(/\"/g,'\"\"')+'\"'}function s(e){var r=w;if(!e[\"!ref\"])throw new Error(\"Cannot export empty sheet to DIF\");var t=en(e[\"!ref\"]);var a=e[\"!data\"]!=null;var s=['TABLE\\r\\n0,1\\r\\n\"sheetjs\"\\r\\n',\"VECTORS\\r\\n0,\"+(t.e.r-t.s.r+1)+'\\r\\n\"\"\\r\\n',\"TUPLES\\r\\n0,\"+(t.e.c-t.s.c+1)+'\\r\\n\"\"\\r\\n','DATA\\r\\n0,0\\r\\n\"\"\\r\\n'];for(var l=t.s.r;l<=t.e.r;++l){var o=a?e[\"!data\"][l]:[];var c=\"-1,0\\r\\nBOT\\r\\n\";for(var f=t.s.c;f<=t.e.c;++f){var u=a?o&&o[f]:e[Ja({r:l,c:f})];if(u==null){c+='1,0\\r\\n\"\"\\r\\n';continue}switch(u.t){case\"n\":if(r){if(u.w!=null)c+=\"0,\"+u.w+\"\\r\\nV\";else if(u.v!=null)c+=n(u.v,\"V\");else if(u.f!=null&&!u.F)c+=i(\"=\"+u.f);else c+='1,0\\r\\n\"\"'}else{if(u.v==null)c+='1,0\\r\\n\"\"';else c+=n(u.v,\"V\")}break;case\"b\":c+=u.v?n(1,\"TRUE\"):n(0,\"FALSE\");break;case\"s\":c+=i(!r||isNaN(+u.v)?u.v:'=\"'+u.v+'\"');break;case\"d\":if(!u.w)u.w=$e(u.z||q[14],dr(wr(u.v)));if(r)c+=n(u.w,\"V\");else c+=i(u.w);break;default:c+='1,0\\r\\n\"\"';}c+=\"\\r\\n\"}s.push(c)}return s.join(\"\")+\"-1,0\\r\\nEOD\"}return{to_workbook:a,to_sheet:t,from_sheet:s}}();var fi=function(){function e(e){return e.replace(/\\\\b/g,\"\\\\\").replace(/\\\\c/g,\":\").replace(/\\\\n/g,\"\\n\")}function r(e){return e.replace(/\\\\/g,\"\\\\b\").replace(/:/g,\"\\\\c\").replace(/\\n/g,\"\\\\n\")}function t(r,t){var a=r.split(\"\\n\"),n=-1,i=-1,s=0,l=[];for(;s!==a.length;++s){var o=a[s].trim().split(\":\");if(o[0]!==\"cell\")continue;var c=Ya(o[1]);if(l.length<=c.r)for(n=l.length;n<=c.r;++n)if(!l[n])l[n]=[];n=c.r;i=c.c;switch(o[2]){case\"t\":l[n][i]=e(o[3]);break;case\"v\":l[n][i]=+o[3];break;case\"vtf\":var f=o[o.length-1];case\"vtc\":switch(o[3]){case\"nl\":l[n][i]=+o[4]?true:false;break;default:l[n][i]=o[o.length-1].charAt(0)==\"#\"?{t:\"e\",v:Fn[o[o.length-1]]}:+o[4];break;}if(o[2]==\"vtf\")l[n][i]=[l[n][i],f];}}if(t&&t.sheetRows)l=l.slice(0,t.sheetRows);return l}function a(e,r){return ln(t(e,r),r)}function n(e,r){return an(a(e,r),r)}var i=[\"socialcalc:version:1.5\",\"MIME-Version: 1.0\",\"Content-Type: multipart/mixed; boundary=SocialCalcSpreadsheetControlSave\"].join(\"\\n\");var s=[\"--SocialCalcSpreadsheetControlSave\",\"Content-type: text/plain; charset=UTF-8\"].join(\"\\n\")+\"\\n\";var l=[\"# SocialCalc Spreadsheet Control Save\",\"part:sheet\"].join(\"\\n\");var o=\"--SocialCalcSpreadsheetControlSave--\";function c(e){if(!e||!e[\"!ref\"])return\"\";var t=[],a=[],n,i=\"\";var s=Za(e[\"!ref\"]);var l=e[\"!data\"]!=null;for(var o=s.s.r;o<=s.e.r;++o){for(var c=s.s.c;c<=s.e.c;++c){i=Ja({r:o,c:c});n=l?(e[\"!data\"][o]||[])[c]:e[i];if(!n||n.v==null||n.t===\"z\")continue;a=[\"cell\",i,\"t\"];switch(n.t){case\"s\":a.push(r(n.v));break;case\"b\":a[2]=\"vt\"+(n.f?\"f\":\"c\");a[3]=\"nl\";a[4]=n.v?\"1\":\"0\";a[5]=r(n.f||(n.v?\"TRUE\":\"FALSE\"));break;case\"d\":var f=dr(wr(n.v));a[2]=\"vtc\";a[3]=\"nd\";a[4]=\"\"+f;a[5]=n.w||$e(n.z||q[14],f);break;case\"n\":if(isFinite(n.v)){if(!n.f){a[2]=\"v\";a[3]=n.v}else{a[2]=\"vtf\";a[3]=\"n\";a[4]=n.v;a[5]=r(n.f)}}else{a[2]=\"vt\"+(n.f?\"f\":\"c\");a[3]=\"e\"+En[isNaN(n.v)?36:7];a[4]=\"0\";a[5]=n.f||a[3].slice(1);a[6]=\"e\";a[7]=a[3].slice(1)}break;case\"e\":continue;}t.push(a.join(\":\"))}}t.push(\"sheet:c:\"+(s.e.c-s.s.c+1)+\":r:\"+(s.e.r-s.s.r+1)+\":tvf:1\");t.push(\"valueformat:1:text-wiki\");return t.join(\"\\n\")}function f(e){return[i,s,l,s,c(e),o].join(\"\\n\")}return{to_workbook:n,to_sheet:a,from_sheet:f}}();var ui=function(){function e(e,r,t,a,n){if(n.raw)r[t][a]=e;else if(e===\"\"){}else if(e===\"TRUE\")r[t][a]=true;else if(e===\"FALSE\")r[t][a]=false;else if(!isNaN(Cr(e)))r[t][a]=Cr(e);else if(!isNaN(Or(e).getDate()))r[t][a]=wr(e);else if(e.charCodeAt(0)==35&&Fn[e]!=null)r[t][a]={t:\"e\",v:Fn[e],w:e};else r[t][a]=e}function r(r,t){var a=t||{};var n=[];if(!r||r.length===0)return n;var i=r.split(/[\\r\\n]/);var s=i.length-1;while(s>=0&&i[s].length===0)--s;var l=10,o=0;var c=0;for(;c<=s;++c){o=i[c].indexOf(\" \");if(o==-1)o=i[c].length;else o++;l=Math.max(l,o)}for(c=0;c<=s;++c){n[c]=[];var f=0;e(i[c].slice(0,l).trim(),n,c,f,a);for(f=1;f<=(i[c].length-l)/10+1;++f)e(i[c].slice(l+(f-1)*10,l+f*10).trim(),n,c,f,a)}if(a.sheetRows)n=n.slice(0,a.sheetRows);return n}var t={44:\",\",9:\"\\t\",59:\";\",124:\"|\"};var n={44:3,9:2,59:1,124:0};function i(e){var r={},a=false,i=0,s=0;for(;i<e.length;++i){if((s=e.charCodeAt(i))==34)a=!a;else if(!a&&s in t)r[s]=(r[s]||0)+1}s=[];for(i in r)if(Object.prototype.hasOwnProperty.call(r,i)){s.push([r[i],i])}if(!s.length){r=n;for(i in r)if(Object.prototype.hasOwnProperty.call(r,i)){s.push([r[i],i])}}s.sort(function(e,r){return e[0]-r[0]||n[e[1]]-n[r[1]]});return t[s.pop()[1]]||44}function s(e,r){var t=r||{};var a=\"\";if(b!=null&&t.dense==null)t.dense=b;var n={};if(t.dense)n[\"!data\"]=[];var s={s:{c:0,r:0},e:{c:0,r:0}};if(e.slice(0,4)==\"sep=\"){if(e.charCodeAt(5)==13&&e.charCodeAt(6)==10){a=e.charAt(4);e=e.slice(7)}else if(e.charCodeAt(5)==13||e.charCodeAt(5)==10){a=e.charAt(4);e=e.slice(6)}else a=i(e.slice(0,1024))}else if(t&&t.FS)a=t.FS;else a=i(e.slice(0,1024));var l=0,o=0,c=0;var f=0,u=0,h=a.charCodeAt(0),d=false,p=0,m=e.charCodeAt(0);var v=t.dateNF!=null?Ye(t.dateNF):null;function g(){var r=e.slice(f,u);if(r.slice(-1)==\"\\r\")r=r.slice(0,-1);var a={};if(r.charAt(0)=='\"'&&r.charAt(r.length-1)=='\"')r=r.slice(1,-1).replace(/\"\"/g,'\"');if(t.cellText!==false)a.w=r;if(r.length===0)a.t=\"z\";else if(t.raw){a.t=\"s\";a.v=r}else if(r.trim().length===0){a.t=\"s\";a.v=r}else if(r.charCodeAt(0)==61){if(r.charCodeAt(1)==34&&r.charCodeAt(r.length-1)==34){a.t=\"s\";a.v=r.slice(2,-1).replace(/\"\"/g,'\"')}else if(Ls(r)){a.t=\"s\";a.f=r.slice(1);a.v=r}else{a.t=\"s\";a.v=r}}else if(r==\"TRUE\"){a.t=\"b\";a.v=true}else if(r==\"FALSE\"){a.t=\"b\";a.v=false}else if(!isNaN(c=Cr(r))){a.t=\"n\";a.v=c}else if(!isNaN((c=Or(r)).getDate())||v&&r.match(v)){a.z=t.dateNF||q[14];if(v&&r.match(v)){var i=Je(r,t.dateNF,r.match(v)||[]);c=wr(i);if(t&&t.UTC===false)c=Mr(c)}else if(t&&t.UTC===false)c=Mr(c);else if(t.cellText!==false&&t.dateNF)a.w=$e(a.z,c);if(t.cellDates){a.t=\"d\";a.v=c}else{a.t=\"n\";a.v=dr(c)}if(!t.cellNF)delete a.z}else if(r.charCodeAt(0)==35&&Fn[r]!=null){a.t=\"e\";a.w=r;a.v=Fn[r]}else{a.t=\"s\";a.v=r}if(a.t==\"z\"){}else if(t.dense){if(!n[\"!data\"][l])n[\"!data\"][l]=[];n[\"!data\"][l][o]=a}else n[Ja({c:o,r:l})]=a;f=u+1;m=e.charCodeAt(f);if(s.e.c<o)s.e.c=o;if(s.e.r<l)s.e.r=l;if(p==h)++o;else{o=0;++l;if(t.sheetRows&&t.sheetRows<=l)return true}}e:for(;u<e.length;++u)switch(p=e.charCodeAt(u)){case 34:if(m===34)d=!d;break;case 13:if(d)break;if(e.charCodeAt(u+1)==10)++u;case h:;case 10:if(!d&&g())break e;break;default:break;}if(u-f>0)g();n[\"!ref\"]=Ka(s);return n}function l(e,t){if(!(t&&t.PRN))return s(e,t);if(t.FS)return s(e,t);if(e.slice(0,4)==\"sep=\")return s(e,t);if(e.indexOf(\"\\t\")>=0||e.indexOf(\",\")>=0||e.indexOf(\";\")>=0)return s(e,t);return ln(r(e,t),t)}function o(e,r){var t=\"\",n=r.type==\"string\"?[0,0,0,0]:Uo(e,r);switch(r.type){case\"base64\":t=S(e);break;case\"binary\":t=e;break;case\"buffer\":if(r.codepage==65001)t=e.toString(\"utf8\");else if(r.codepage&&typeof a!==\"undefined\")t=a.utils.decode(r.codepage,e);else t=_&&Buffer.isBuffer(e)?e.toString(\"binary\"):N(e);break;case\"array\":t=kr(e);break;case\"string\":t=e;break;default:throw new Error(\"Unrecognized type \"+r.type);}if(n[0]==239&&n[1]==187&&n[2]==191)t=Dt(t.slice(3));else if(r.type!=\"string\"&&r.type!=\"buffer\"&&r.codepage==65001)t=Dt(t);else if(r.type==\"binary\"&&typeof a!==\"undefined\"&&r.codepage)t=a.utils.decode(r.codepage,a.utils.encode(28591,t));if(t.slice(0,19)==\"socialcalc:version:\")return fi.to_sheet(r.type==\"string\"?t:Dt(t),r);return l(t,r)}function c(e,r){return an(o(e,r),r)}function f(e){var r=[];if(!e[\"!ref\"])return\"\";var t=en(e[\"!ref\"]),a;var n=e[\"!data\"]!=null;for(var i=t.s.r;i<=t.e.r;++i){var s=[];for(var l=t.s.c;l<=t.e.c;++l){var o=Ja({r:i,c:l});a=n?(e[\"!data\"][i]||[])[l]:e[o];if(!a||a.v==null){s.push(\"          \");continue}var c=(a.w||(tn(a),a.w)||\"\").slice(0,10);while(c.length<10)c+=\" \";s.push(c+(l===0?\" \":\"\"))}r.push(s.join(\"\"))}return r.join(\"\\n\")}return{to_workbook:c,to_sheet:o,from_sheet:f}}();function hi(e,r){var t=r||{},a=!!t.WTF;t.WTF=true;try{var n=oi.to_workbook(e,t);t.WTF=a;return n}catch(i){t.WTF=a;if(i.message.indexOf(\"SYLK bad record ID\")==-1&&a)throw i;return ui.to_workbook(e,r)}}function di(e){var r={},t=e.match(lt),a=0;var n=false;if(t)for(;a!=t.length;++a){var s=ft(t[a]);switch(s[0].replace(/<\\w*:/g,\"<\")){case\"<condense\":break;case\"<extend\":break;case\"<shadow\":if(!s.val)break;case\"<shadow>\":;case\"<shadow/>\":r.shadow=1;break;case\"</shadow>\":break;case\"<charset\":if(s.val==\"1\")break;r.cp=i[parseInt(s.val,10)];break;case\"<outline\":if(!s.val)break;case\"<outline>\":;case\"<outline/>\":r.outline=1;break;case\"</outline>\":break;case\"<rFont\":r.name=s.val;break;case\"<sz\":r.sz=s.val;break;case\"<strike\":if(!s.val)break;case\"<strike>\":;case\"<strike/>\":r.strike=1;break;case\"</strike>\":break;case\"<u\":if(!s.val)break;switch(s.val){case\"double\":r.uval=\"double\";break;case\"singleAccounting\":r.uval=\"single-accounting\";break;case\"doubleAccounting\":r.uval=\"double-accounting\";break;};case\"<u>\":;case\"<u/>\":r.u=1;break;case\"</u>\":break;case\"<b\":if(s.val==\"0\")break;case\"<b>\":;case\"<b/>\":r.b=1;break;case\"</b>\":break;case\"<i\":if(s.val==\"0\")break;case\"<i>\":;case\"<i/>\":r.i=1;break;case\"</i>\":break;case\"<color\":if(s.rgb)r.color=s.rgb.slice(2,8);break;case\"<color>\":;case\"<color/>\":;case\"</color>\":break;case\"<family\":r.family=s.val;break;case\"<family>\":;case\"<family/>\":;case\"</family>\":break;case\"<vertAlign\":r.valign=s.val;break;case\"<vertAlign>\":;case\"<vertAlign/>\":;case\"</vertAlign>\":break;case\"<scheme\":break;case\"<scheme>\":;case\"<scheme/>\":;case\"</scheme>\":break;case\"<extLst\":;case\"<extLst>\":;case\"</extLst>\":break;case\"<ext\":n=true;break;case\"</ext>\":n=false;break;default:if(s[0].charCodeAt(1)!==47&&!n)throw new Error(\"Unrecognized rich format \"+s[0]);}}return r}var pi=function(){function e(e){var r=zr(e,\"t\");if(!r)return{t:\"s\",v:\"\"};var t={t:\"s\",v:mt(r[1])};var a=zr(e,\"rPr\");if(a)t.s=di(a[1]);return t}var r=/<(?:\\w+:)?r>/g,t=/<\\/(?:\\w+:)?r>/;return function a(n){return n.replace(r,\"\").split(t).map(e).filter(function(e){return e.v})}}();var mi=function Vc(){var e=/(\\r\\n|\\n)/g;function r(e,r,t){var a=[];if(e.u)a.push(\"text-decoration: underline;\");if(e.uval)a.push(\"text-underline-style:\"+e.uval+\";\");if(e.sz)a.push(\"font-size:\"+e.sz+\"pt;\");if(e.outline)a.push(\"text-effect: outline;\");if(e.shadow)a.push(\"text-shadow: auto;\");r.push('<span style=\"'+a.join(\"\")+'\">');if(e.b){r.push(\"<b>\");t.push(\"</b>\")}if(e.i){r.push(\"<i>\");t.push(\"</i>\")}if(e.strike){r.push(\"<s>\");t.push(\"</s>\")}var n=e.valign||\"\";if(n==\"superscript\"||n==\"super\")n=\"sup\";else if(n==\"subscript\")n=\"sub\";if(n!=\"\"){r.push(\"<\"+n+\">\");t.push(\"</\"+n+\">\")}t.push(\"</span>\");return e}function t(t){var a=[[],t.v,[]];if(!t.v)return\"\";if(t.s)r(t.s,a[0],a[2]);return a[0].join(\"\")+a[1].replace(e,\"<br/>\")+a[2].join(\"\")}return function a(e){return e.map(t).join(\"\")}}();var vi=/<(?:\\w+:)?t\\b[^<>]*>([^<]*)<\\/(?:\\w+:)?t>/g,gi=/<(?:\\w+:)?r\\b[^<>]*>/;function bi(e,r){var t=r?r.cellHTML:true;var a={};if(!e)return{t:\"\"};if(e.match(/^\\s*<(?:\\w+:)?t[^>]*>/)){a.t=mt(Dt(e.slice(e.indexOf(\">\")+1).split(/<\\/(?:\\w+:)?t>/)[0]||\"\"),true);a.r=Dt(e);if(t)a.h=yt(a.t)}else if(e.match(gi)){a.r=Dt(e);a.t=mt(Dt((Wr(e,\"rPh\").match(vi)||[]).join(\"\").replace(lt,\"\")),true);if(t)a.h=mi(pi(a.r))}return a}var wi=/<(?:\\w+:)?(?:si|sstItem)>/g;var ki=/<\\/(?:\\w+:)?(?:si|sstItem)>/;function yi(e,r){var t=[],a=\"\";if(!e)return t;var n=zr(e,\"sst\");if(n){a=n[1].replace(wi,\"\").split(ki);for(var i=0;i!=a.length;++i){var s=bi(a[i].trim(),r);if(s!=null)t[t.length]=s}n=ft(n[0].slice(0,n[0].indexOf(\">\")));t.Count=n.count;t.Unique=n.uniqueCount}return t}var xi=/^\\s|\\s$|[\\t\\n\\r]/;function Ci(e,r){if(!r.bookSST)return\"\";var t=[at];t[t.length]=Bt(\"sst\",null,{xmlns:Vt[0],count:e.Count,uniqueCount:e.Unique});for(var a=0;a!=e.length;++a){if(e[a]==null)continue;var n=e[a];var i=\"<si>\";if(n.r)i+=n.r;else{i+=\"<t\";if(!n.t)n.t=\"\";if(typeof n.t!==\"string\")n.t=String(n.t);if(n.t.match(xi))i+=' xml:space=\"preserve\"';i+=\">\"+bt(n.t)+\"</t>\"}i+=\"</si>\";t[t.length]=i}if(t.length>2){t[t.length]=\"</sst>\";t[1]=t[1].replace(\"/>\",\">\")}return t.join(\"\")}function Si(e){var r=e.slice(e[0]===\"#\"?1:0).slice(0,6);return[parseInt(r.slice(0,2),16),parseInt(r.slice(2,4),16),parseInt(r.slice(4,6),16)]}function _i(e){for(var r=0,t=1;r!=3;++r)t=t*256+(e[r]>255?255:e[r]<0?0:e[r]);return t.toString(16).toUpperCase().slice(1)}function Ai(e){var r=e[0]/255,t=e[1]/255,a=e[2]/255;var n=Math.max(r,t,a),i=Math.min(r,t,a),s=n-i;if(s===0)return[0,0,r];var l=0,o=0,c=n+i;o=s/(c>1?2-c:c);switch(n){case r:l=((t-a)/s+6)%6;break;case t:l=(a-r)/s+2;break;case a:l=(r-t)/s+4;break;}return[l/6,o,c/2]}function Ti(e){var r=e[0],t=e[1],a=e[2];var n=t*2*(a<.5?a:1-a),i=a-n/2;var s=[i,i,i],l=6*r;var o;if(t!==0)switch(l|0){case 0:;case 6:o=n*l;s[0]+=n;s[1]+=o;break;case 1:o=n*(2-l);s[0]+=o;s[1]+=n;break;case 2:o=n*(l-2);s[1]+=n;s[2]+=o;break;case 3:o=n*(4-l);s[1]+=o;s[2]+=n;break;case 4:o=n*(l-4);s[2]+=n;s[0]+=o;break;case 5:o=n*(6-l);s[2]+=o;s[0]+=n;break;}for(var c=0;c!=3;++c)s[c]=Math.round(s[c]*255);return s}function Ei(e,r){if(r===0)return e;var t=Ai(Si(e));if(r<0)t[2]=t[2]*(1+r);else t[2]=1-(1-t[2])*(1-r);return _i(Ti(t))}var Fi=6,Di=15,Oi=1,Ni=Fi;function Mi(e){return Math.floor((e+Math.round(128/Ni)/256)*Ni)}function Ii(e){return Math.floor((e-5)/Ni*100+.5)/100}function Pi(e){return Math.round((e*Ni+5)/Ni*256)/256}function Ri(e){return Pi(Ii(Mi(e)))}function Li(e){var r=Math.abs(e-Ri(e)),t=Ni;if(r>.005)for(Ni=Oi;Ni<Di;++Ni)if(Math.abs(e-Ri(e))<=r){r=Math.abs(e-Ri(e));t=Ni}Ni=t}function Ui(e){if(e.width){e.wpx=Mi(e.width);e.wch=Ii(e.wpx);e.MDW=Ni}else if(e.wpx){e.wch=Ii(e.wpx);e.width=Pi(e.wch);e.MDW=Ni}else if(typeof e.wch==\"number\"){e.width=Pi(e.wch);e.wpx=Mi(e.width);e.MDW=Ni}if(e.customWidth)delete e.customWidth}var Bi=96,zi=Bi;function $i(e){return e*96/zi}function Wi(e){return e*zi/96}var ji={None:\"none\",Solid:\"solid\",Gray50:\"mediumGray\",Gray75:\"darkGray\",Gray25:\"lightGray\",HorzStripe:\"darkHorizontal\",VertStripe:\"darkVertical\",ReverseDiagStripe:\"darkDown\",DiagStripe:\"darkUp\",DiagCross:\"darkGrid\",ThickDiagCross:\"darkTrellis\",ThinHorzStripe:\"lightHorizontal\",ThinVertStripe:\"lightVertical\",ThinReverseDiagStripe:\"lightDown\",ThinHorzCross:\"lightGrid\"};function Hi(e,r,t,a){r.Borders=[];var n={};var i=false;(e.match(lt)||[]).forEach(function(e){var t=ft(e);switch(ht(t[0])){case\"<borders\":;case\"<borders>\":;case\"</borders>\":break;case\"<border\":;case\"<border>\":;case\"<border/>\":n={};if(t.diagonalUp)n.diagonalUp=_t(t.diagonalUp);if(t.diagonalDown)n.diagonalDown=_t(t.diagonalDown);r.Borders.push(n);break;case\"</border>\":break;case\"<left/>\":break;case\"<left\":;case\"<left>\":break;case\"</left>\":break;case\"<right/>\":break;case\"<right\":;case\"<right>\":break;case\"</right>\":break;case\"<top/>\":break;case\"<top\":;case\"<top>\":break;case\"</top>\":break;case\"<bottom/>\":break;case\"<bottom\":;case\"<bottom>\":break;case\"</bottom>\":break;case\"<diagonal\":;case\"<diagonal>\":;case\"<diagonal/>\":break;case\"</diagonal>\":break;case\"<horizontal\":;case\"<horizontal>\":;case\"<horizontal/>\":break;case\"</horizontal>\":break;case\"<vertical\":;case\"<vertical>\":;case\"<vertical/>\":break;case\"</vertical>\":break;case\"<start\":;case\"<start>\":;case\"<start/>\":break;case\"</start>\":break;case\"<end\":;case\"<end>\":;case\"<end/>\":break;case\"</end>\":break;case\"<color\":;case\"<color>\":break;case\"<color/>\":;case\"</color>\":break;case\"<extLst\":;case\"<extLst>\":;case\"</extLst>\":break;case\"<ext\":i=true;break;case\"</ext>\":i=false;break;default:if(a&&a.WTF){if(!i)throw new Error(\"unrecognized \"+t[0]+\" in borders\")};}})}function Vi(e,r,t,a){r.Fills=[];var n={};var i=false;(e.match(lt)||[]).forEach(function(e){var t=ft(e);switch(ht(t[0])){case\"<fills\":;case\"<fills>\":;case\"</fills>\":break;case\"<fill>\":;case\"<fill\":;case\"<fill/>\":n={};r.Fills.push(n);break;case\"</fill>\":break;case\"<gradientFill>\":break;case\"<gradientFill\":;case\"</gradientFill>\":r.Fills.push(n);n={};break;case\"<patternFill\":;case\"<patternFill>\":if(t.patternType)n.patternType=t.patternType;break;case\"<patternFill/>\":;case\"</patternFill>\":break;case\"<bgColor\":if(!n.bgColor)n.bgColor={};if(t.indexed)n.bgColor.indexed=parseInt(t.indexed,10);if(t.theme)n.bgColor.theme=parseInt(t.theme,10);if(t.tint)n.bgColor.tint=parseFloat(t.tint);if(t.rgb)n.bgColor.rgb=t.rgb.slice(-6);break;case\"<bgColor/>\":;case\"</bgColor>\":break;case\"<fgColor\":if(!n.fgColor)n.fgColor={};if(t.theme)n.fgColor.theme=parseInt(t.theme,10);if(t.tint)n.fgColor.tint=parseFloat(t.tint);if(t.rgb!=null)n.fgColor.rgb=t.rgb.slice(-6);break;case\"<fgColor/>\":;case\"</fgColor>\":break;case\"<stop\":;case\"<stop/>\":break;case\"</stop>\":break;case\"<color\":;case\"<color/>\":break;case\"</color>\":break;case\"<extLst\":;case\"<extLst>\":;case\"</extLst>\":break;case\"<ext\":i=true;break;case\"</ext>\":i=false;break;default:if(a&&a.WTF){if(!i)throw new Error(\"unrecognized \"+t[0]+\" in fills\")};}})}function Xi(e,r,t,a){r.Fonts=[];var n={};var s=false;(e.match(lt)||[]).forEach(function(e){var l=ft(e);switch(ht(l[0])){case\"<fonts\":;case\"<fonts>\":;case\"</fonts>\":break;case\"<font\":;case\"<font>\":break;case\"</font>\":;case\"<font/>\":r.Fonts.push(n);n={};break;case\"<name\":if(l.val)n.name=Dt(l.val);break;case\"<name/>\":;case\"</name>\":break;case\"<b\":n.bold=l.val?_t(l.val):1;break;case\"<b/>\":n.bold=1;break;case\"</b>\":;case\"</b\":break;case\"<i\":n.italic=l.val?_t(l.val):1;break;case\"<i/>\":n.italic=1;break;case\"</i>\":;case\"</i\":break;case\"<u\":switch(l.val){case\"none\":n.underline=0;break;case\"single\":n.underline=1;break;case\"double\":n.underline=2;break;case\"singleAccounting\":n.underline=33;break;case\"doubleAccounting\":n.underline=34;break;}break;case\"<u/>\":n.underline=1;break;case\"</u>\":;case\"</u\":break;case\"<strike\":n.strike=l.val?_t(l.val):1;break;case\"<strike/>\":n.strike=1;break;case\"</strike>\":;case\"</strike\":break;case\"<outline\":n.outline=l.val?_t(l.val):1;break;case\"<outline/>\":n.outline=1;break;case\"</outline>\":;case\"</outline\":break;case\"<shadow\":n.shadow=l.val?_t(l.val):1;break;case\"<shadow/>\":n.shadow=1;break;case\"</shadow>\":;case\"</shadow\":break;case\"<condense\":n.condense=l.val?_t(l.val):1;break;case\"<condense/>\":n.condense=1;break;case\"</condense>\":;case\"</condense\":break;case\"<extend\":n.extend=l.val?_t(l.val):1;break;case\"<extend/>\":n.extend=1;break;case\"</extend>\":;case\"</extend\":break;case\"<sz\":if(l.val)n.sz=+l.val;break;case\"<sz/>\":;case\"</sz>\":;case\"</sz\":break;case\"<vertAlign\":if(l.val)n.vertAlign=l.val;break;case\"<vertAlign/>\":;case\"</vertAlign>\":;case\"</vertAlign\":break;case\"<family\":if(l.val)n.family=parseInt(l.val,10);break;case\"<family/>\":;case\"</family>\":;case\"</family\":break;case\"<scheme\":if(l.val)n.scheme=l.val;break;case\"<scheme/>\":;case\"</scheme>\":;case\"</scheme\":break;case\"<charset\":if(l.val==\"1\")break;l.codepage=i[parseInt(l.val,10)];break;case\"<charset/>\":;case\"</charset>\":;case\"</charset\":break;case\"<color\":if(!n.color)n.color={};if(l.auto)n.color.auto=_t(l.auto);if(l.rgb)n.color.rgb=l.rgb.slice(-6);else if(l.indexed){n.color.index=parseInt(l.indexed,10);var o=Tn[n.color.index];if(n.color.index==81)o=Tn[1];if(!o)o=Tn[1];n.color.rgb=o[0].toString(16)+o[1].toString(16)+o[2].toString(16)}else if(l.theme){n.color.theme=parseInt(l.theme,10);if(l.tint)n.color.tint=parseFloat(l.tint);if(l.theme&&t.themeElements&&t.themeElements.clrScheme){n.color.rgb=Ei(t.themeElements.clrScheme[n.color.theme].rgb,n.color.tint||0)}}break;case\"<color/>\":;case\"</color>\":;case\"</color\":break;case\"<AlternateContent\":s=true;break;case\"</AlternateContent>\":;case\"</AlternateContent\":s=false;break;case\"<extLst\":;case\"<extLst>\":;case\"</extLst>\":break;case\"<ext\":s=true;break;case\"</ext>\":s=false;break;default:if(a&&a.WTF){if(!s)throw new Error(\"unrecognized \"+l[0]+\" in fonts\")};}})}function Gi(e,r,t){r.NumberFmt=[];var a=ir(q);for(var n=0;n<a.length;++n)r.NumberFmt[a[n]]=q[a[n]];var i=e.match(lt);if(!i)return;for(n=0;n<i.length;++n){var s=ft(i[n]);switch(ht(s[0])){case\"<numFmts\":;case\"</numFmts>\":;case\"<numFmts/>\":;case\"<numFmts>\":break;case\"<numFmt\":{var l=mt(Dt(s.formatCode)),o=parseInt(s.numFmtId,10);r.NumberFmt[o]=l;if(o>0){if(o>392){for(o=392;o>60;--o)if(r.NumberFmt[o]==null)break;r.NumberFmt[o]=l}Ke(l,o)}}break;case\"</numFmt>\":break;default:if(t.WTF)throw new Error(\"unrecognized \"+s[0]+\" in numFmts\");}}}function Yi(e){var r=[\"<numFmts>\"];[[5,8],[23,26],[41,44],[50,392]].forEach(function(t){for(var a=t[0];a<=t[1];++a)if(e[a]!=null)r[r.length]=Bt(\"numFmt\",null,{numFmtId:a,formatCode:bt(e[a])})});if(r.length===1)return\"\";r[r.length]=\"</numFmts>\";r[0]=Bt(\"numFmts\",null,{count:r.length-2}).replace(\"/>\",\">\");return r.join(\"\")}var Ji=[\"numFmtId\",\"fillId\",\"fontId\",\"borderId\",\"xfId\"];var Zi=[\"applyAlignment\",\"applyBorder\",\"applyFill\",\"applyFont\",\"applyNumberFormat\",\"applyProtection\",\"pivotButton\",\"quotePrefix\"];function Ki(e,r,t){r.CellXf=[];var a;var n=false;(e.match(lt)||[]).forEach(function(e){var i=ft(e),s=0;switch(ht(i[0])){case\"<cellXfs\":;case\"<cellXfs>\":;case\"<cellXfs/>\":;case\"</cellXfs>\":break;case\"<xf\":;case\"<xf/>\":;case\"<xf>\":a=i;delete a[0];for(s=0;s<Ji.length;++s)if(a[Ji[s]])a[Ji[s]]=parseInt(a[Ji[s]],10);for(s=0;s<Zi.length;++s)if(a[Zi[s]])a[Zi[s]]=_t(a[Zi[s]]);if(r.NumberFmt&&a.numFmtId>392){for(s=392;s>60;--s)if(r.NumberFmt[a.numFmtId]==r.NumberFmt[s]){a.numFmtId=s;break}}r.CellXf.push(a);break;case\"</xf>\":break;case\"<alignment\":;case\"<alignment/>\":;case\"<alignment>\":var l={};if(i.vertical)l.vertical=i.vertical;if(i.horizontal)l.horizontal=i.horizontal;if(i.textRotation!=null)l.textRotation=i.textRotation;if(i.indent)l.indent=i.indent;if(i.wrapText)l.wrapText=_t(i.wrapText);a.alignment=l;break;case\"</alignment>\":break;case\"<protection\":;case\"<protection>\":break;case\"</protection>\":;case\"<protection/>\":break;case\"<AlternateContent\":;case\"<AlternateContent>\":n=true;break;case\"</AlternateContent>\":n=false;break;case\"<extLst\":;case\"<extLst>\":;case\"</extLst>\":break;case\"<ext\":n=true;break;case\"</ext>\":n=false;break;default:if(t&&t.WTF){if(!n)throw new Error(\"unrecognized \"+i[0]+\" in cellXfs\")};}})}function qi(e){var r=[];r[r.length]=Bt(\"cellXfs\",null);e.forEach(function(e){r[r.length]=Bt(\"xf\",null,e)});r[r.length]=\"</cellXfs>\";if(r.length===2)return\"\";r[0]=Bt(\"cellXfs\",null,{count:r.length-2}).replace(\"/>\",\">\");return r.join(\"\")}var Qi=function Xc(){return function e(r,t,a){var n={};if(!r)return n;r=Pr(Lr(r,\"<!--\",\"-->\"));var i;if(i=zr(r,\"numFmts\"))Gi(i[0],n,a);if(i=zr(r,\"fonts\"))Xi(i[0],n,t,a);if(i=zr(r,\"fills\"))Vi(i[0],n,t,a);if(i=zr(r,\"borders\"))Hi(i[0],n,t,a);if(i=zr(r,\"cellXfs\"))Ki(i[0],n,a);return n}}();function es(e,r){var t=[at,Bt(\"styleSheet\",null,{\nxmlns:Vt[0],\"xmlns:vt\":Ht.vt})],a;if(e.SSF&&(a=Yi(e.SSF))!=null)t[t.length]=a;t[t.length]='<fonts count=\"1\"><font><sz val=\"12\"/><color theme=\"1\"/><name val=\"Calibri\"/><family val=\"2\"/><scheme val=\"minor\"/></font></fonts>';t[t.length]='<fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills>';t[t.length]='<borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders>';t[t.length]='<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>';if(a=qi(r.cellXfs))t[t.length]=a;t[t.length]='<cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles>';t[t.length]='<dxfs count=\"0\"/>';t[t.length]='<tableStyles count=\"0\" defaultTableStyle=\"TableStyleMedium9\" defaultPivotStyle=\"PivotStyleMedium4\"/>';if(t.length>2){t[t.length]=\"</styleSheet>\";t[1]=t[1].replace(\"/>\",\">\")}return t.join(\"\")}var rs=[\"</a:lt1>\",\"</a:dk1>\",\"</a:lt2>\",\"</a:dk2>\",\"</a:accent1>\",\"</a:accent2>\",\"</a:accent3>\",\"</a:accent4>\",\"</a:accent5>\",\"</a:accent6>\",\"</a:hlink>\",\"</a:folHlink>\"];function ts(e,r,t){r.themeElements.clrScheme=[];var a={};(e[0].match(lt)||[]).forEach(function(e){var n=ft(e);switch(n[0]){case\"<a:clrScheme\":;case\"</a:clrScheme>\":break;case\"<a:srgbClr\":a.rgb=n.val;break;case\"</a:srgbClr>\":break;case\"<a:sysClr\":a.rgb=n.lastClr;break;case\"</a:sysClr>\":break;case\"</a:dk1>\":;case\"</a:lt1>\":;case\"<a:dk1>\":;case\"<a:lt1>\":;case\"<a:dk2>\":;case\"</a:dk2>\":;case\"<a:lt2>\":;case\"</a:lt2>\":;case\"<a:accent1>\":;case\"</a:accent1>\":;case\"<a:accent2>\":;case\"</a:accent2>\":;case\"<a:accent3>\":;case\"</a:accent3>\":;case\"<a:accent4>\":;case\"</a:accent4>\":;case\"<a:accent5>\":;case\"</a:accent5>\":;case\"<a:accent6>\":;case\"</a:accent6>\":;case\"<a:hlink>\":;case\"</a:hlink>\":;case\"<a:folHlink>\":;case\"</a:folHlink>\":if(n[0].charAt(1)===\"/\"){r.themeElements.clrScheme[rs.indexOf(n[0])]=a;a={}}else{a.name=n[0].slice(3,n[0].length-1)}break;default:if(t&&t.WTF)throw new Error(\"Unrecognized \"+n[0]+\" in clrScheme\");}})}function as(){}function ns(){}function is(e,r,t){r.themeElements={};var a;if(!(a=Br(e,\"a:clrScheme\")))throw new Error(\"clrScheme not found in themeElements\");ts(a,r,t);if(!(a=Br(e,\"a:fontScheme\")))throw new Error(\"fontScheme not found in themeElements\");as(a,r,t);if(!(a=Br(e,\"a:fmtScheme\")))throw new Error(\"fmtScheme not found in themeElements\");ns(a,r,t)}function ss(e,r){if(!e||e.length===0)e=ls();var t;var a={};if(!(t=Br(e,\"a:themeElements\")))throw new Error(\"themeElements not found in theme\");is(t[0],a,r);a.raw=e;return a}function ls(e,r){if(r&&r.themeXLSX)return r.themeXLSX;if(e&&typeof e.raw==\"string\")return e.raw;var t=[at];t[t.length]='<a:theme xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" name=\"Office Theme\">';t[t.length]=\"<a:themeElements>\";t[t.length]='<a:clrScheme name=\"Office\">';t[t.length]='<a:dk1><a:sysClr val=\"windowText\" lastClr=\"000000\"/></a:dk1>';t[t.length]='<a:lt1><a:sysClr val=\"window\" lastClr=\"FFFFFF\"/></a:lt1>';t[t.length]='<a:dk2><a:srgbClr val=\"1F497D\"/></a:dk2>';t[t.length]='<a:lt2><a:srgbClr val=\"EEECE1\"/></a:lt2>';t[t.length]='<a:accent1><a:srgbClr val=\"4F81BD\"/></a:accent1>';t[t.length]='<a:accent2><a:srgbClr val=\"C0504D\"/></a:accent2>';t[t.length]='<a:accent3><a:srgbClr val=\"9BBB59\"/></a:accent3>';t[t.length]='<a:accent4><a:srgbClr val=\"8064A2\"/></a:accent4>';t[t.length]='<a:accent5><a:srgbClr val=\"4BACC6\"/></a:accent5>';t[t.length]='<a:accent6><a:srgbClr val=\"F79646\"/></a:accent6>';t[t.length]='<a:hlink><a:srgbClr val=\"0000FF\"/></a:hlink>';t[t.length]='<a:folHlink><a:srgbClr val=\"800080\"/></a:folHlink>';t[t.length]=\"</a:clrScheme>\";t[t.length]='<a:fontScheme name=\"Office\">';t[t.length]=\"<a:majorFont>\";t[t.length]='<a:latin typeface=\"Cambria\"/>';t[t.length]='<a:ea typeface=\"\"/>';t[t.length]='<a:cs typeface=\"\"/>';t[t.length]='<a:font script=\"Jpan\" typeface=\"ＭＳ Ｐゴシック\"/>';t[t.length]='<a:font script=\"Hang\" typeface=\"맑은 고딕\"/>';t[t.length]='<a:font script=\"Hans\" typeface=\"宋体\"/>';t[t.length]='<a:font script=\"Hant\" typeface=\"新細明體\"/>';t[t.length]='<a:font script=\"Arab\" typeface=\"Times New Roman\"/>';t[t.length]='<a:font script=\"Hebr\" typeface=\"Times New Roman\"/>';t[t.length]='<a:font script=\"Thai\" typeface=\"Tahoma\"/>';t[t.length]='<a:font script=\"Ethi\" typeface=\"Nyala\"/>';t[t.length]='<a:font script=\"Beng\" typeface=\"Vrinda\"/>';t[t.length]='<a:font script=\"Gujr\" typeface=\"Shruti\"/>';t[t.length]='<a:font script=\"Khmr\" typeface=\"MoolBoran\"/>';t[t.length]='<a:font script=\"Knda\" typeface=\"Tunga\"/>';t[t.length]='<a:font script=\"Guru\" typeface=\"Raavi\"/>';t[t.length]='<a:font script=\"Cans\" typeface=\"Euphemia\"/>';t[t.length]='<a:font script=\"Cher\" typeface=\"Plantagenet Cherokee\"/>';t[t.length]='<a:font script=\"Yiii\" typeface=\"Microsoft Yi Baiti\"/>';t[t.length]='<a:font script=\"Tibt\" typeface=\"Microsoft Himalaya\"/>';t[t.length]='<a:font script=\"Thaa\" typeface=\"MV Boli\"/>';t[t.length]='<a:font script=\"Deva\" typeface=\"Mangal\"/>';t[t.length]='<a:font script=\"Telu\" typeface=\"Gautami\"/>';t[t.length]='<a:font script=\"Taml\" typeface=\"Latha\"/>';t[t.length]='<a:font script=\"Syrc\" typeface=\"Estrangelo Edessa\"/>';t[t.length]='<a:font script=\"Orya\" typeface=\"Kalinga\"/>';t[t.length]='<a:font script=\"Mlym\" typeface=\"Kartika\"/>';t[t.length]='<a:font script=\"Laoo\" typeface=\"DokChampa\"/>';t[t.length]='<a:font script=\"Sinh\" typeface=\"Iskoola Pota\"/>';t[t.length]='<a:font script=\"Mong\" typeface=\"Mongolian Baiti\"/>';t[t.length]='<a:font script=\"Viet\" typeface=\"Times New Roman\"/>';t[t.length]='<a:font script=\"Uigh\" typeface=\"Microsoft Uighur\"/>';t[t.length]='<a:font script=\"Geor\" typeface=\"Sylfaen\"/>';t[t.length]=\"</a:majorFont>\";t[t.length]=\"<a:minorFont>\";t[t.length]='<a:latin typeface=\"Calibri\"/>';t[t.length]='<a:ea typeface=\"\"/>';t[t.length]='<a:cs typeface=\"\"/>';t[t.length]='<a:font script=\"Jpan\" typeface=\"ＭＳ Ｐゴシック\"/>';t[t.length]='<a:font script=\"Hang\" typeface=\"맑은 고딕\"/>';t[t.length]='<a:font script=\"Hans\" typeface=\"宋体\"/>';t[t.length]='<a:font script=\"Hant\" typeface=\"新細明體\"/>';t[t.length]='<a:font script=\"Arab\" typeface=\"Arial\"/>';t[t.length]='<a:font script=\"Hebr\" typeface=\"Arial\"/>';t[t.length]='<a:font script=\"Thai\" typeface=\"Tahoma\"/>';t[t.length]='<a:font script=\"Ethi\" typeface=\"Nyala\"/>';t[t.length]='<a:font script=\"Beng\" typeface=\"Vrinda\"/>';t[t.length]='<a:font script=\"Gujr\" typeface=\"Shruti\"/>';t[t.length]='<a:font script=\"Khmr\" typeface=\"DaunPenh\"/>';t[t.length]='<a:font script=\"Knda\" typeface=\"Tunga\"/>';t[t.length]='<a:font script=\"Guru\" typeface=\"Raavi\"/>';t[t.length]='<a:font script=\"Cans\" typeface=\"Euphemia\"/>';t[t.length]='<a:font script=\"Cher\" typeface=\"Plantagenet Cherokee\"/>';t[t.length]='<a:font script=\"Yiii\" typeface=\"Microsoft Yi Baiti\"/>';t[t.length]='<a:font script=\"Tibt\" typeface=\"Microsoft Himalaya\"/>';t[t.length]='<a:font script=\"Thaa\" typeface=\"MV Boli\"/>';t[t.length]='<a:font script=\"Deva\" typeface=\"Mangal\"/>';t[t.length]='<a:font script=\"Telu\" typeface=\"Gautami\"/>';t[t.length]='<a:font script=\"Taml\" typeface=\"Latha\"/>';t[t.length]='<a:font script=\"Syrc\" typeface=\"Estrangelo Edessa\"/>';t[t.length]='<a:font script=\"Orya\" typeface=\"Kalinga\"/>';t[t.length]='<a:font script=\"Mlym\" typeface=\"Kartika\"/>';t[t.length]='<a:font script=\"Laoo\" typeface=\"DokChampa\"/>';t[t.length]='<a:font script=\"Sinh\" typeface=\"Iskoola Pota\"/>';t[t.length]='<a:font script=\"Mong\" typeface=\"Mongolian Baiti\"/>';t[t.length]='<a:font script=\"Viet\" typeface=\"Arial\"/>';t[t.length]='<a:font script=\"Uigh\" typeface=\"Microsoft Uighur\"/>';t[t.length]='<a:font script=\"Geor\" typeface=\"Sylfaen\"/>';t[t.length]=\"</a:minorFont>\";t[t.length]=\"</a:fontScheme>\";t[t.length]='<a:fmtScheme name=\"Office\">';t[t.length]=\"<a:fillStyleLst>\";t[t.length]='<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>';t[t.length]='<a:gradFill rotWithShape=\"1\">';t[t.length]=\"<a:gsLst>\";t[t.length]='<a:gs pos=\"0\"><a:schemeClr val=\"phClr\"><a:tint val=\"50000\"/><a:satMod val=\"300000\"/></a:schemeClr></a:gs>';t[t.length]='<a:gs pos=\"35000\"><a:schemeClr val=\"phClr\"><a:tint val=\"37000\"/><a:satMod val=\"300000\"/></a:schemeClr></a:gs>';t[t.length]='<a:gs pos=\"100000\"><a:schemeClr val=\"phClr\"><a:tint val=\"15000\"/><a:satMod val=\"350000\"/></a:schemeClr></a:gs>';t[t.length]=\"</a:gsLst>\";t[t.length]='<a:lin ang=\"16200000\" scaled=\"1\"/>';t[t.length]=\"</a:gradFill>\";t[t.length]='<a:gradFill rotWithShape=\"1\">';t[t.length]=\"<a:gsLst>\";t[t.length]='<a:gs pos=\"0\"><a:schemeClr val=\"phClr\"><a:tint val=\"100000\"/><a:shade val=\"100000\"/><a:satMod val=\"130000\"/></a:schemeClr></a:gs>';t[t.length]='<a:gs pos=\"100000\"><a:schemeClr val=\"phClr\"><a:tint val=\"50000\"/><a:shade val=\"100000\"/><a:satMod val=\"350000\"/></a:schemeClr></a:gs>';t[t.length]=\"</a:gsLst>\";t[t.length]='<a:lin ang=\"16200000\" scaled=\"0\"/>';t[t.length]=\"</a:gradFill>\";t[t.length]=\"</a:fillStyleLst>\";t[t.length]=\"<a:lnStyleLst>\";t[t.length]='<a:ln w=\"9525\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:solidFill><a:schemeClr val=\"phClr\"><a:shade val=\"95000\"/><a:satMod val=\"105000\"/></a:schemeClr></a:solidFill><a:prstDash val=\"solid\"/></a:ln>';t[t.length]='<a:ln w=\"25400\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:prstDash val=\"solid\"/></a:ln>';t[t.length]='<a:ln w=\"38100\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:prstDash val=\"solid\"/></a:ln>';t[t.length]=\"</a:lnStyleLst>\";t[t.length]=\"<a:effectStyleLst>\";t[t.length]=\"<a:effectStyle>\";t[t.length]=\"<a:effectLst>\";t[t.length]='<a:outerShdw blurRad=\"40000\" dist=\"20000\" dir=\"5400000\" rotWithShape=\"0\"><a:srgbClr val=\"000000\"><a:alpha val=\"38000\"/></a:srgbClr></a:outerShdw>';t[t.length]=\"</a:effectLst>\";t[t.length]=\"</a:effectStyle>\";t[t.length]=\"<a:effectStyle>\";t[t.length]=\"<a:effectLst>\";t[t.length]='<a:outerShdw blurRad=\"40000\" dist=\"23000\" dir=\"5400000\" rotWithShape=\"0\"><a:srgbClr val=\"000000\"><a:alpha val=\"35000\"/></a:srgbClr></a:outerShdw>';t[t.length]=\"</a:effectLst>\";t[t.length]=\"</a:effectStyle>\";t[t.length]=\"<a:effectStyle>\";t[t.length]=\"<a:effectLst>\";t[t.length]='<a:outerShdw blurRad=\"40000\" dist=\"23000\" dir=\"5400000\" rotWithShape=\"0\"><a:srgbClr val=\"000000\"><a:alpha val=\"35000\"/></a:srgbClr></a:outerShdw>';t[t.length]=\"</a:effectLst>\";t[t.length]='<a:scene3d><a:camera prst=\"orthographicFront\"><a:rot lat=\"0\" lon=\"0\" rev=\"0\"/></a:camera><a:lightRig rig=\"threePt\" dir=\"t\"><a:rot lat=\"0\" lon=\"0\" rev=\"1200000\"/></a:lightRig></a:scene3d>';t[t.length]='<a:sp3d><a:bevelT w=\"63500\" h=\"25400\"/></a:sp3d>';t[t.length]=\"</a:effectStyle>\";t[t.length]=\"</a:effectStyleLst>\";t[t.length]=\"<a:bgFillStyleLst>\";t[t.length]='<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>';t[t.length]='<a:gradFill rotWithShape=\"1\">';t[t.length]=\"<a:gsLst>\";t[t.length]='<a:gs pos=\"0\"><a:schemeClr val=\"phClr\"><a:tint val=\"40000\"/><a:satMod val=\"350000\"/></a:schemeClr></a:gs>';t[t.length]='<a:gs pos=\"40000\"><a:schemeClr val=\"phClr\"><a:tint val=\"45000\"/><a:shade val=\"99000\"/><a:satMod val=\"350000\"/></a:schemeClr></a:gs>';t[t.length]='<a:gs pos=\"100000\"><a:schemeClr val=\"phClr\"><a:shade val=\"20000\"/><a:satMod val=\"255000\"/></a:schemeClr></a:gs>';t[t.length]=\"</a:gsLst>\";t[t.length]='<a:path path=\"circle\"><a:fillToRect l=\"50000\" t=\"-80000\" r=\"50000\" b=\"180000\"/></a:path>';t[t.length]=\"</a:gradFill>\";t[t.length]='<a:gradFill rotWithShape=\"1\">';t[t.length]=\"<a:gsLst>\";t[t.length]='<a:gs pos=\"0\"><a:schemeClr val=\"phClr\"><a:tint val=\"80000\"/><a:satMod val=\"300000\"/></a:schemeClr></a:gs>';t[t.length]='<a:gs pos=\"100000\"><a:schemeClr val=\"phClr\"><a:shade val=\"30000\"/><a:satMod val=\"200000\"/></a:schemeClr></a:gs>';t[t.length]=\"</a:gsLst>\";t[t.length]='<a:path path=\"circle\"><a:fillToRect l=\"50000\" t=\"50000\" r=\"50000\" b=\"50000\"/></a:path>';t[t.length]=\"</a:gradFill>\";t[t.length]=\"</a:bgFillStyleLst>\";t[t.length]=\"</a:fmtScheme>\";t[t.length]=\"</a:themeElements>\";t[t.length]=\"<a:objectDefaults>\";t[t.length]=\"<a:spDef>\";t[t.length]='<a:spPr/><a:bodyPr/><a:lstStyle/><a:style><a:lnRef idx=\"1\"><a:schemeClr val=\"accent1\"/></a:lnRef><a:fillRef idx=\"3\"><a:schemeClr val=\"accent1\"/></a:fillRef><a:effectRef idx=\"2\"><a:schemeClr val=\"accent1\"/></a:effectRef><a:fontRef idx=\"minor\"><a:schemeClr val=\"lt1\"/></a:fontRef></a:style>';t[t.length]=\"</a:spDef>\";t[t.length]=\"<a:lnDef>\";t[t.length]='<a:spPr/><a:bodyPr/><a:lstStyle/><a:style><a:lnRef idx=\"2\"><a:schemeClr val=\"accent1\"/></a:lnRef><a:fillRef idx=\"0\"><a:schemeClr val=\"accent1\"/></a:fillRef><a:effectRef idx=\"1\"><a:schemeClr val=\"accent1\"/></a:effectRef><a:fontRef idx=\"minor\"><a:schemeClr val=\"tx1\"/></a:fontRef></a:style>';t[t.length]=\"</a:lnDef>\";t[t.length]=\"</a:objectDefaults>\";t[t.length]=\"<a:extraClrSchemeLst/>\";t[t.length]=\"</a:theme>\";return t.join(\"\")}function os(e,r,t){var a={Types:[],Cell:[],Value:[]};if(!e)return a;var n=false;var i=2;var s;e.replace(lt,function(e){var r=ft(e);switch(ht(r[0])){case\"<?xml\":break;case\"<metadata\":;case\"</metadata>\":break;case\"<metadataTypes\":;case\"</metadataTypes>\":break;case\"<metadataType\":a.Types.push({name:r.name});break;case\"</metadataType>\":break;case\"<futureMetadata\":for(var l=0;l<a.Types.length;++l)if(a.Types[l].name==r.name)s=a.Types[l];break;case\"</futureMetadata>\":break;case\"<bk>\":break;case\"</bk>\":break;case\"<rc\":if(i==1)a.Cell.push({type:a.Types[r.t-1].name,index:+r.v});else if(i==0)a.Value.push({type:a.Types[r.t-1].name,index:+r.v});break;case\"</rc>\":break;case\"<cellMetadata\":i=1;break;case\"</cellMetadata>\":i=2;break;case\"<valueMetadata\":i=0;break;case\"</valueMetadata>\":i=2;break;case\"<extLst\":;case\"<extLst>\":;case\"</extLst>\":;case\"<extLst/>\":break;case\"<ext\":n=true;break;case\"</ext>\":n=false;break;case\"<rvb\":if(!s)break;if(!s.offsets)s.offsets=[];s.offsets.push(+r.i);break;default:if(!n&&(t==null?void 0:t.WTF))throw new Error(\"unrecognized \"+r[0]+\" in metadata\");}return e});return a}function cs(){var e=[at];e.push('<metadata xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:xlrd=\"http://schemas.microsoft.com/office/spreadsheetml/2017/richdata\" xmlns:xda=\"http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray\">\\n  <metadataTypes count=\"1\">\\n    <metadataType name=\"XLDAPR\" minSupportedVersion=\"120000\" copy=\"1\" pasteAll=\"1\" pasteValues=\"1\" merge=\"1\" splitFirst=\"1\" rowColShift=\"1\" clearFormats=\"1\" clearComments=\"1\" assign=\"1\" coerce=\"1\" cellMeta=\"1\"/>\\n  </metadataTypes>\\n  <futureMetadata name=\"XLDAPR\" count=\"1\">\\n    <bk>\\n      <extLst>\\n        <ext uri=\"{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}\">\\n          <xda:dynamicArrayProperties fDynamic=\"1\" fCollapsed=\"0\"/>\\n        </ext>\\n      </extLst>\\n    </bk>\\n  </futureMetadata>\\n  <cellMetadata count=\"1\">\\n    <bk>\\n      <rc t=\"1\" v=\"0\"/>\\n    </bk>\\n  </cellMetadata>\\n</metadata>');return e.join(\"\")}function fs(){}function us(e,r,t,a){if(!e)return e;var n=a||{};var i=false,s=false;Na(e,function l(e,r,t){if(s)return;switch(t){case 359:;case 363:;case 364:;case 366:;case 367:;case 368:;case 369:;case 370:;case 371:;case 472:;case 577:;case 578:;case 579:;case 580:;case 581:;case 582:;case 583:;case 584:;case 585:;case 586:;case 587:break;case 35:i=true;break;case 36:i=false;break;default:if(r.T){}else if(!i||n.WTF)throw new Error(\"Unexpected record 0x\"+t.toString(16));}},n)}function hs(e,r){if(!e)return\"??\";var t=(e.match(/<c:chart [^<>]*r:id=\"([^<>\"]*)\"/)||[\"\",\"\"])[1];return r[\"!id\"][t].Target}function ds(e,r,t){var a=0;($r(e,\"shape\")||[]).forEach(function(e){var n=\"\";var i=true;var s=-1;var l=-1,o=-1;e.replace(lt,function(r,t){var a=ft(r);switch(ht(a[0])){case\"<ClientData\":if(a.ObjectType)n=a.ObjectType;break;case\"<Visible\":;case\"<Visible/>\":i=false;break;case\"<Row\":;case\"<Row>\":s=t+r.length;break;case\"</Row>\":l=+e.slice(s,t).trim();break;case\"<Column\":;case\"<Column>\":s=t+r.length;break;case\"</Column>\":o=+e.slice(s,t).trim();break;}return\"\"});switch(n){case\"Note\":var c=bc(r,l>=0&&o>=0?Ja({r:l,c:o}):t[a].ref);if(c.c){c.c.hidden=i}++a;break;}})}function ps(e,r,t){var a=[21600,21600];var n=[\"m0,0l0\",a[1],a[0],a[1],a[0],\"0xe\"].join(\",\");var i=[Bt(\"xml\",null,{\"xmlns:v\":Xt.v,\"xmlns:o\":Xt.o,\"xmlns:x\":Xt.x,\"xmlns:mv\":Xt.mv}).replace(/\\/>/,\">\"),Bt(\"o:shapelayout\",Bt(\"o:idmap\",null,{\"v:ext\":\"edit\",data:e}),{\"v:ext\":\"edit\"})];var s=65536*e;var l=r||[];if(l.length>0)i.push(Bt(\"v:shapetype\",[Bt(\"v:stroke\",null,{joinstyle:\"miter\"}),Bt(\"v:path\",null,{gradientshapeok:\"t\",\"o:connecttype\":\"rect\"})].join(\"\"),{id:\"_x0000_t202\",coordsize:a.join(\",\"),\"o:spt\":202,path:n}));l.forEach(function(e){++s;i.push(ms(e,s))});i.push(\"</xml>\");return i.join(\"\")}function ms(e,r,t){var a=Ya(e[0]);var n={color2:\"#BEFF82\",type:\"gradient\"};if(n.type==\"gradient\")n.angle=\"-180\";var i=n.type==\"gradient\"?Bt(\"o:fill\",null,{type:\"gradientUnscaled\",\"v:ext\":\"view\"}):null;var s=Bt(\"v:fill\",i,n);var l={on:\"t\",obscured:\"t\"};return[\"<v:shape\"+Ut({id:\"_x0000_s\"+r,type:\"#_x0000_t202\",style:\"position:absolute; margin-left:80pt;margin-top:5pt;width:104pt;height:64pt;z-index:10\"+(e[1].hidden?\";visibility:hidden\":\"\"),fillcolor:\"#ECFAD4\",strokecolor:\"#edeaa1\"})+\">\",s,Bt(\"v:shadow\",null,l),Bt(\"v:path\",null,{\"o:connecttype\":\"none\"}),'<v:textbox><div style=\"text-align:left\"></div></v:textbox>','<x:ClientData ObjectType=\"Note\">',\"<x:MoveWithCells/>\",\"<x:SizeWithCells/>\",Lt(\"x:Anchor\",[a.c+1,0,a.r+1,0,a.c+3,20,a.r+5,20].join(\",\")),Lt(\"x:AutoFill\",\"False\"),Lt(\"x:Row\",String(a.r)),Lt(\"x:Column\",String(a.c)),e[1].hidden?\"\":\"<x:Visible/>\",\"</x:ClientData>\",\"</v:shape>\"].join(\"\")}function vs(e,r,t,a){var n=e[\"!data\"]!=null;var i;r.forEach(function(r){var s=Ya(r.ref);if(s.r<0||s.c<0)return;if(n){if(!e[\"!data\"][s.r])e[\"!data\"][s.r]=[];i=e[\"!data\"][s.r][s.c]}else i=e[r.ref];if(!i){i={t:\"z\"};if(n)e[\"!data\"][s.r][s.c]=i;else e[r.ref]=i;var l=en(e[\"!ref\"]||\"BDWGO1000001:A1\");if(l.s.r>s.r)l.s.r=s.r;if(l.e.r<s.r)l.e.r=s.r;if(l.s.c>s.c)l.s.c=s.c;if(l.e.c<s.c)l.e.c=s.c;var o=Ka(l);e[\"!ref\"]=o}if(!i.c)i.c=[];var c={a:r.author,t:r.t,r:r.r,T:t};if(r.h)c.h=r.h;for(var f=i.c.length-1;f>=0;--f){if(!t&&i.c[f].T)return;if(t&&!i.c[f].T)i.c.splice(f,1)}if(t&&a)for(f=0;f<a.length;++f){if(c.a==a[f].id){c.a=a[f].name||c.a;break}}i.c.push(c)})}function gs(e,r){if(e.match(/<(?:\\w+:)?comments *\\/>/))return[];var t=[];var a=[];var n=zr(e,\"authors\");if(n&&n[1])n[1].split(/<\\/\\w*:?author>/).forEach(function(e){if(e===\"\"||e.trim()===\"\")return;var r=e.match(/<(?:\\w+:)?author[^<>]*>(.*)/);if(r)t.push(r[1])});var i=zr(e,\"commentList\");if(i&&i[1])i[1].split(/<\\/\\w*:?comment>/).forEach(function(e){if(e===\"\"||e.trim()===\"\")return;var n=e.match(/<(?:\\w+:)?comment[^<>]*>/);if(!n)return;var i=ft(n[0]);var s={author:i.authorId&&t[i.authorId]||\"sheetjsghost\",ref:i.ref,guid:i.guid};var l=Ya(i.ref);if(r.sheetRows&&r.sheetRows<=l.r)return;var o=zr(e,\"text\");var c=!!o&&!!o[1]&&bi(o[1])||{r:\"\",t:\"\",h:\"\"};s.r=c.r;if(c.r==\"<t></t>\")c.t=c.h=\"\";s.t=(c.t||\"\").replace(/\\r\\n/g,\"\\n\").replace(/\\r/g,\"\\n\");if(r.cellHTML)s.h=c.h;a.push(s)});return a}function bs(e){var r=[at,Bt(\"comments\",null,{xmlns:Vt[0]})];var t=[];r.push(\"<authors>\");e.forEach(function(e){e[1].forEach(function(e){var a=bt(e.a);if(t.indexOf(a)==-1){t.push(a);r.push(\"<author>\"+a+\"</author>\")}if(e.T&&e.ID&&t.indexOf(\"tc=\"+e.ID)==-1){t.push(\"tc=\"+e.ID);r.push(\"<author>\"+\"tc=\"+e.ID+\"</author>\")}})});if(t.length==0){t.push(\"SheetJ5\");r.push(\"<author>SheetJ5</author>\")}r.push(\"</authors>\");r.push(\"<commentList>\");e.forEach(function(e){var a=0,n=[],i=0;if(e[1][0]&&e[1][0].T&&e[1][0].ID)a=t.indexOf(\"tc=\"+e[1][0].ID);e[1].forEach(function(e){if(e.a)a=t.indexOf(bt(e.a));if(e.T)++i;n.push(e.t==null?\"\":bt(e.t))});if(i===0){e[1].forEach(function(a){r.push('<comment ref=\"'+e[0]+'\" authorId=\"'+t.indexOf(bt(a.a))+'\"><text>');r.push(Lt(\"t\",a.t==null?\"\":bt(a.t)));r.push(\"</text></comment>\")})}else{if(e[1][0]&&e[1][0].T&&e[1][0].ID)a=t.indexOf(\"tc=\"+e[1][0].ID);r.push('<comment ref=\"'+e[0]+'\" authorId=\"'+a+'\"><text>');var s=\"Comment:\\n    \"+n[0]+\"\\n\";for(var l=1;l<n.length;++l)s+=\"Reply:\\n    \"+n[l]+\"\\n\";r.push(Lt(\"t\",bt(s)));r.push(\"</text></comment>\")}});r.push(\"</commentList>\");if(r.length>2){r[r.length]=\"</comments>\";r[1]=r[1].replace(\"/>\",\">\")}return r.join(\"\")}function ws(e,r){var t=[];var a=false,n={},i=0;e.replace(lt,function s(l,o){var c=ft(l);switch(ht(c[0])){case\"<?xml\":break;case\"<ThreadedComments\":break;case\"</ThreadedComments>\":break;case\"<threadedComment\":n={author:c.personId,guid:c.id,ref:c.ref,T:1};break;case\"</threadedComment>\":if(n.t!=null)t.push(n);break;case\"<text>\":;case\"<text\":i=o+l.length;break;case\"</text>\":n.t=e.slice(i,o).replace(/\\r\\n/g,\"\\n\").replace(/\\r/g,\"\\n\");break;case\"<mentions\":;case\"<mentions>\":a=true;break;case\"</mentions>\":a=false;break;case\"<extLst\":;case\"<extLst>\":;case\"</extLst>\":;case\"<extLst/>\":break;case\"<ext\":a=true;break;case\"</ext>\":a=false;break;default:if(!a&&r.WTF)throw new Error(\"unrecognized \"+c[0]+\" in threaded comments\");}return l});return t}function ks(e,r,t){var a=[at,Bt(\"ThreadedComments\",null,{xmlns:Ht.TCMNT}).replace(/[\\/]>/,\">\")];e.forEach(function(e){var n=\"\";(e[1]||[]).forEach(function(i,s){if(!i.T){delete i.ID;return}if(i.a&&r.indexOf(i.a)==-1)r.push(i.a);var l={ref:e[0],id:\"{54EE7951-7262-4200-6969-\"+(\"000000000000\"+t.tcid++).slice(-12)+\"}\"};if(s==0)n=l.id;else l.parentId=n;i.ID=l.id;if(i.a)l.personId=\"{54EE7950-7262-4200-6969-\"+(\"000000000000\"+r.indexOf(i.a)).slice(-12)+\"}\";a.push(Bt(\"threadedComment\",Lt(\"text\",i.t||\"\"),l))})});a.push(\"</ThreadedComments>\");return a.join(\"\")}function ys(e,r){var t=[];var a=false;e.replace(lt,function n(e){var n=ft(e);switch(ht(n[0])){case\"<?xml\":break;case\"<personList\":break;case\"</personList>\":break;case\"<person\":t.push({name:n.displayname,id:n.id});break;case\"</person>\":break;case\"<extLst\":;case\"<extLst>\":;case\"</extLst>\":;case\"<extLst/>\":break;case\"<ext\":a=true;break;case\"</ext>\":a=false;break;default:if(!a&&r.WTF)throw new Error(\"unrecognized \"+n[0]+\" in threaded comments\");}return e});return t}function xs(e){var r=[at,Bt(\"personList\",null,{xmlns:Ht.TCMNT,\"xmlns:x\":Vt[0]}).replace(/[\\/]>/,\">\")];e.forEach(function(e,t){r.push(Bt(\"person\",null,{displayName:e,id:\"{54EE7950-7262-4200-6969-\"+(\"000000000000\"+t).slice(-12)+\"}\",userId:e,providerId:\"None\"}))});r.push(\"</personList>\");return r.join(\"\")}var Cs=\"application/vnd.ms-office.vbaProject\";function Ss(e){var r=Qe.utils.cfb_new({root:\"R\"});e.FullPaths.forEach(function(t,a){if(t.slice(-1)===\"/\"||!t.match(/_VBA_PROJECT_CUR/))return;var n=t.replace(/^[^\\/]*/,\"R\").replace(/\\/_VBA_PROJECT_CUR\\u0000*/,\"\");Qe.utils.cfb_add(r,n,e.FileIndex[a].content)});return Qe.write(r)}function _s(e,r){r.FullPaths.forEach(function(t,a){if(a==0)return;var n=t.replace(/^[\\/]*[^\\/]*[\\/]/,\"/_VBA_PROJECT_CUR/\");if(n.slice(-1)!==\"/\")Qe.utils.cfb_add(e,n,r.FileIndex[a].content)})}var As=[\"xlsb\",\"xlsm\",\"xlam\",\"biff8\",\"xla\"];function Ts(){return{\"!type\":\"dialog\"}}function Es(){return{\"!type\":\"dialog\"}}function Fs(){return{\"!type\":\"macro\"}}function Ds(){return{\"!type\":\"macro\"}}var Os=function(){var e=/(^|[^A-Za-z_])R(\\[?-?\\d+\\]|[1-9]\\d*|)C(\\[?-?\\d+\\]|[1-9]\\d*|)(?![A-Za-z0-9_])/g;var r={r:0,c:0};function t(e,t,a,n){var i=false,s=false;if(a.length==0)s=true;else if(a.charAt(0)==\"[\"){s=true;a=a.slice(1,-1)}if(n.length==0)i=true;else if(n.charAt(0)==\"[\"){i=true;n=n.slice(1,-1)}var l=a.length>0?parseInt(a,10)|0:0,o=n.length>0?parseInt(n,10)|0:0;if(i)o+=r.c;else--o;if(s)l+=r.r;else--l;return t+(i?\"\":\"$\")+Ha(o)+(s?\"\":\"$\")+za(l)}return function a(n,i){r=i;return n.replace(e,t)}}();var Ns=/(^|[^._A-Z0-9])(\\$?)([A-Z]{1,2}|[A-W][A-Z]{2}|X[A-E][A-Z]|XF[A-D])(\\$?)(\\d{1,7})(?![_.\\(A-Za-z0-9])/g;try{Ns=/(^|[^._A-Z0-9])([$]?)([A-Z]{1,2}|[A-W][A-Z]{2}|X[A-E][A-Z]|XF[A-D])([$]?)(10[0-3]\\d{4}|104[0-7]\\d{3}|1048[0-4]\\d{2}|10485[0-6]\\d|104857[0-6]|[1-9]\\d{0,5})(?![_.\\(A-Za-z0-9])/g}catch(Ms){}var Is=function(){return function e(r,t){return r.replace(Ns,function(e,r,a,n,i,s){var l=ja(n)-(a?0:t.c);var o=Ba(s)-(i?0:t.r);var c=i==\"$\"?o+1:o==0?\"\":\"[\"+o+\"]\";var f=a==\"$\"?l+1:l==0?\"\":\"[\"+l+\"]\";return r+\"R\"+c+\"C\"+f})}}();function Ps(e,r){return e.replace(Ns,function(e,t,a,n,i,s){return t+(a==\"$\"?a+n:Ha(ja(n)+r.c))+(i==\"$\"?i+s:za(Ba(s)+r.r))})}function Rs(e,r,t){var a=Za(r),n=a.s,i=Ya(t);var s={r:i.r-n.r,c:i.c-n.c};return Ps(e,s)}function Ls(e){if(e.length==1)return false;return true}function Us(e){return e.replace(/_xlfn\\./g,\"\")}function Bs(e){if(e.slice(0,3)==\"of:\")e=e.slice(3);if(e.charCodeAt(0)==61){e=e.slice(1);if(e.charCodeAt(0)==61)e=e.slice(1)}e=e.replace(/COM\\.MICROSOFT\\./g,\"\");e=e.replace(/\\[((?:\\.[A-Z]+[0-9]+)(?::\\.[A-Z]+[0-9]+)?)\\]/g,function(e,r){return r.replace(/\\./g,\"\")});e=e.replace(/\\$'([^']|'')+'/g,function(e){return e.slice(1)});e=e.replace(/\\$([^\\]\\. #$]+)/g,function(e,r){return r.match(/^([A-Z]{1,2}|[A-W][A-Z]{2}|X[A-E][A-Z]|XF[A-D])?(10[0-3]\\d{4}|104[0-7]\\d{3}|1048[0-4]\\d{2}|10485[0-6]\\d|104857[0-6]|[1-9]\\d{0,5})?$/)?e:r});e=e.replace(/\\[.(#[A-Z]*[?!])\\]/g,\"$1\");return e.replace(/[;~]/g,\",\").replace(/\\|/g,\";\")}function zs(e){var r=\"of:=\"+e.replace(Ns,\"$1[.$2$3$4$5]\").replace(/\\]:\\[/g,\":\");return r.replace(/;/g,\"|\").replace(/,/g,\";\")}function $s(e){e=e.replace(/\\$'([^']|'')+'/g,function(e){return e.slice(1)});e=e.replace(/\\$([^\\]\\. #$]+)/g,function(e,r){return r.match(/^([A-Z]{1,2}|[A-W][A-Z]{2}|X[A-E][A-Z]|XF[A-D])?(10[0-3]\\d{4}|104[0-7]\\d{3}|1048[0-4]\\d{2}|10485[0-6]\\d|104857[0-6]|[1-9]\\d{0,5})?$/)?e:r});var r=e.split(\":\");var t=r[0].split(\".\")[0];return[t,r[0].split(\".\")[1]+(r.length>1?\":\"+(r[1].split(\".\")[1]||r[1].split(\".\")[0]):\"\")]}function Ws(e){return e.replace(/!/,\".\").replace(/:/,\":.\")}var js={};var Hs={};var Vs=typeof Map!==\"undefined\";function Xs(e,r,t){var a=0,n=e.length;if(t){if(Vs?t.has(r):Object.prototype.hasOwnProperty.call(t,r)){var i=Vs?t.get(r):t[r];for(;a<i.length;++a){if(e[i[a]].t===r){e.Count++;return i[a]}}}}else for(;a<n;++a){if(e[a].t===r){e.Count++;return a}}e[n]={t:r};e.Count++;e.Unique++;if(t){if(Vs){if(!t.has(r))t.set(r,[]);t.get(r).push(n)}else{if(!Object.prototype.hasOwnProperty.call(t,r))t[r]=[];t[r].push(n)}}return n}function Gs(e,r){var t={min:e+1,max:e+1};var a=-1;if(r.MDW)Ni=r.MDW;if(r.width!=null)t.customWidth=1;else if(r.wpx!=null)a=Ii(r.wpx);else if(r.wch!=null)a=r.wch;if(a>-1){t.width=Pi(a);t.customWidth=1}else if(r.width!=null)t.width=r.width;if(r.hidden)t.hidden=true;if(r.level!=null){t.outlineLevel=t.level=r.level}return t}function Ys(e,r){if(!e)return;var t=[.7,.7,.75,.75,.3,.3];if(r==\"xlml\")t=[1,1,1,1,.5,.5];if(e.left==null)e.left=t[0];if(e.right==null)e.right=t[1];if(e.top==null)e.top=t[2];if(e.bottom==null)e.bottom=t[3];if(e.header==null)e.header=t[4];if(e.footer==null)e.footer=t[5]}function Js(e,r,t){var a=t.revssf[r.z!=null?r.z:\"General\"];var n=60,i=e.length;if(a==null&&t.ssf){for(;n<392;++n)if(t.ssf[n]==null){Ke(r.z,n);t.ssf[n]=r.z;t.revssf[r.z]=a=n;break}}for(n=0;n!=i;++n)if(e[n].numFmtId===a)return n;e[i]={numFmtId:a,fontId:0,fillId:0,borderId:0,xfId:0,applyNumberFormat:1};return i}function Zs(e,r,t,a,n,i,s){try{if(a.cellNF)e.z=q[r]}catch(l){if(a.WTF)throw l}if(e.t===\"z\"&&!a.cellStyles)return;if(e.t===\"d\"&&typeof e.v===\"string\")e.v=wr(e.v);if((!a||a.cellText!==false)&&e.t!==\"z\")try{if(q[r]==null)Ke(Xe[r]||\"General\",r);if(e.t===\"e\")e.w=e.w||En[e.v];else if(r===0){if(e.t===\"n\"){if((e.v|0)===e.v)e.w=e.v.toString(10);else e.w=oe(e.v)}else if(e.t===\"d\"){var o=dr(e.v,!!s);if((o|0)===o)e.w=o.toString(10);else e.w=oe(o)}else if(e.v===undefined)return\"\";else e.w=ce(e.v,Hs)}else if(e.t===\"d\")e.w=$e(r,dr(e.v,!!s),Hs);else e.w=$e(r,e.v,Hs)}catch(l){if(a.WTF)throw l}if(!a.cellStyles)return;if(t!=null)try{e.s=i.Fills[t];if(e.s.fgColor&&e.s.fgColor.theme&&!e.s.fgColor.rgb){e.s.fgColor.rgb=Ei(n.themeElements.clrScheme[e.s.fgColor.theme].rgb,e.s.fgColor.tint||0);if(a.WTF)e.s.fgColor.raw_rgb=n.themeElements.clrScheme[e.s.fgColor.theme].rgb}if(e.s.bgColor&&e.s.bgColor.theme){e.s.bgColor.rgb=Ei(n.themeElements.clrScheme[e.s.bgColor.theme].rgb,e.s.bgColor.tint||0);if(a.WTF)e.s.bgColor.raw_rgb=n.themeElements.clrScheme[e.s.bgColor.theme].rgb}}catch(l){if(a.WTF&&i.Fills)throw l}}function Ks(e,r,t){if(e&&e[\"!ref\"]){var a=en(e[\"!ref\"]);if(a.e.c<a.s.c||a.e.r<a.s.r)throw new Error(\"Bad range (\"+t+\"): \"+e[\"!ref\"])}}function qs(e,r){var t=en(r);if(t.s.r<=t.e.r&&t.s.c<=t.e.c&&t.s.r>=0&&t.s.c>=0)e[\"!ref\"]=Ka(t)}var Qs=/<(?:\\w+:)?mergeCell ref=[\"'][A-Z0-9:]+['\"]\\s*[\\/]?>/g;var el=/<(?:\\w+:)?hyperlink [^<>]*>/gm;var rl=/\"(\\w*:\\w*)\"/;var tl=/<(?:\\w+:)?col\\b[^<>]*[\\/]?>/g;var al=/<(?:\\w+:)?autoFilter[^>]*/g;var nl=/<(?:\\w+:)?pageMargins[^<>]*\\/>/g;var il=/<(?:\\w+:)?sheetPr\\b[^<>]*?\\/>/;function sl(e,r,t,a,n,i,s){if(!e)return e;if(!a)a={\"!id\":{}};if(b!=null&&r.dense==null)r.dense=b;var l={};if(r.dense)l[\"!data\"]=[];var o={s:{r:2e6,c:2e6},e:{r:0,c:0}};var c=\"\",f=\"\";var u=zr(e,\"sheetData\");if(u){c=e.slice(0,u.index);f=e.slice(u.index+u[0].length)}else c=f=e;var h=c.match(il);if(h)ol(h[0],l,n,t);else if(h=zr(c,\"sheetPr\"))cl(h[0],h[1]||\"\",l,n,t,s,i);var d=(c.match(/<(?:\\w*:)?dimension/)||{index:-1}).index;if(d>0){var p=c.slice(d,d+50).match(rl);if(p&&!(r&&r.nodim))qs(l,p[1])}var m=zr(c,\"sheetViews\");if(m&&m[1])xl(m[1],n);var v=[];if(r.cellStyles){var g=c.match(tl);if(g)gl(v,g)}if(u)_l(u[1],l,r,o,i,s,n);var w=f.match(al);if(w)l[\"!autofilter\"]=wl(w[0]);var k=[];var y=f.match(Qs);if(y)for(d=0;d!=y.length;++d)k[d]=en(y[d].slice(y[d].indexOf(\"=\")+2));var x=f.match(el);if(x)pl(l,x,a);var C=f.match(nl);if(C)l[\"!margins\"]=ml(ft(C[0]));var S;if(S=f.match(/legacyDrawing r:id=\"(.*?)\"/))l[\"!legrel\"]=S[1];if(r&&r.nodim)o.s.c=o.s.r=0;if(!l[\"!ref\"]&&o.e.c>=o.s.c&&o.e.r>=o.s.r)l[\"!ref\"]=Ka(o);if(r.sheetRows>0&&l[\"!ref\"]){var _=en(l[\"!ref\"]);if(r.sheetRows<=+_.e.r){_.e.r=r.sheetRows-1;if(_.e.r>o.e.r)_.e.r=o.e.r;if(_.e.r<_.s.r)_.s.r=_.e.r;if(_.e.c>o.e.c)_.e.c=o.e.c;if(_.e.c<_.s.c)_.s.c=_.e.c;l[\"!fullref\"]=l[\"!ref\"];l[\"!ref\"]=Ka(_)}}if(v.length>0)l[\"!cols\"]=v;if(k.length>0)l[\"!merges\"]=k;if(a[\"!id\"][l[\"!legrel\"]])l[\"!legdrawel\"]=a[\"!id\"][l[\"!legrel\"]];return l}function ll(e){if(e.length===0)return\"\";var r='<mergeCells count=\"'+e.length+'\">';for(var t=0;t!=e.length;++t)r+='<mergeCell ref=\"'+Ka(e[t])+'\"/>';return r+\"</mergeCells>\"}function ol(e,r,t,a){var n=ft(e);if(!t.Sheets[a])t.Sheets[a]={};if(n.codeName)t.Sheets[a].CodeName=mt(Dt(n.codeName))}function cl(e,r,t,a,n){ol(e.slice(0,e.indexOf(\">\")),t,a,n)}function fl(e,r,t,a,n){var i=false;var s={},l=null;if(a.bookType!==\"xlsx\"&&r.vbaraw){var o=r.SheetNames[t];try{if(r.Workbook)o=r.Workbook.Sheets[t].CodeName||o}catch(c){}i=true;s.codeName=Ot(bt(o))}if(e&&e[\"!outline\"]){var f={summaryBelow:1,summaryRight:1};if(e[\"!outline\"].above)f.summaryBelow=0;if(e[\"!outline\"].left)f.summaryRight=0;l=(l||\"\")+Bt(\"outlinePr\",null,f)}if(!i&&!l)return;n[n.length]=Bt(\"sheetPr\",l,s)}var ul=[\"objects\",\"scenarios\",\"selectLockedCells\",\"selectUnlockedCells\"];var hl=[\"formatColumns\",\"formatRows\",\"formatCells\",\"insertColumns\",\"insertRows\",\"insertHyperlinks\",\"deleteColumns\",\"deleteRows\",\"sort\",\"autoFilter\",\"pivotTables\"];function dl(e){var r={sheet:1};ul.forEach(function(t){if(e[t]!=null&&e[t])r[t]=\"1\"});hl.forEach(function(t){if(e[t]!=null&&!e[t])r[t]=\"0\"});if(e.password)r.password=crypto_CreatePasswordVerifier_Method1(e.password).toString(16).toUpperCase();return Bt(\"sheetProtection\",null,r)}function pl(e,r,t){var a=e[\"!data\"]!=null;for(var n=0;n!=r.length;++n){var i=ft(Dt(r[n]),true);if(!i.ref)return;var s=((t||{})[\"!id\"]||[])[i.id];if(s){i.Target=s.Target;if(i.location)i.Target+=\"#\"+mt(i.location)}else{i.Target=\"#\"+mt(i.location);s={Target:i.Target,TargetMode:\"Internal\"}}i.Rel=s;if(i.tooltip){i.Tooltip=i.tooltip;delete i.tooltip}var l=en(i.ref);for(var o=l.s.r;o<=l.e.r;++o)for(var c=l.s.c;c<=l.e.c;++c){var f=Ha(c)+za(o);if(a){if(!e[\"!data\"][o])e[\"!data\"][o]=[];if(!e[\"!data\"][o][c])e[\"!data\"][o][c]={t:\"z\",v:undefined};e[\"!data\"][o][c].l=i}else{if(!e[f])e[f]={t:\"z\",v:undefined};e[f].l=i}}}}function ml(e){var r={};[\"left\",\"right\",\"top\",\"bottom\",\"header\",\"footer\"].forEach(function(t){if(e[t])r[t]=parseFloat(e[t])});return r}function vl(e){Ys(e);return Bt(\"pageMargins\",null,e)}function gl(e,r){var t=false;for(var a=0;a!=r.length;++a){var n=ft(r[a],true);if(n.hidden)n.hidden=_t(n.hidden);var i=parseInt(n.min,10)-1,s=parseInt(n.max,10)-1;if(n.outlineLevel)n.level=+n.outlineLevel||0;delete n.min;delete n.max;n.width=+n.width;if(!t&&n.width){t=true;Li(n.width)}Ui(n);while(i<=s)e[i++]=yr(n);\n}}function bl(e,r){var t=[\"<cols>\"],a;for(var n=0;n!=r.length;++n){if(!(a=r[n]))continue;t[t.length]=Bt(\"col\",null,Gs(n,a))}t[t.length]=\"</cols>\";return t.join(\"\")}function wl(e){var r={ref:(e.match(/ref=\"([^\"]*)\"/)||[])[1]};return r}function kl(e,r,t,a){var n=typeof e.ref==\"string\"?e.ref:Ka(e.ref);if(!t.Workbook)t.Workbook={Sheets:[]};if(!t.Workbook.Names)t.Workbook.Names=[];var i=t.Workbook.Names;var s=Za(n);if(s.s.r==s.e.r){s.e.r=Za(r[\"!ref\"]).e.r;n=Ka(s)}for(var l=0;l<i.length;++l){var o=i[l];if(o.Name!=\"_xlnm._FilterDatabase\")continue;if(o.Sheet!=a)continue;o.Ref=Qa(t.SheetNames[a])+\"!\"+qa(n);break}if(l==i.length)i.push({Name:\"_xlnm._FilterDatabase\",Sheet:a,Ref:\"'\"+t.SheetNames[a]+\"'!\"+n});return Bt(\"autoFilter\",null,{ref:n})}var yl=/<(?:\\w:)?sheetView(?:[^<>a-z][^<>]*)?\\/?>/g;function xl(e,r){if(!r.Views)r.Views=[{}];(e.match(yl)||[]).forEach(function(e,t){var a=ft(e);if(!r.Views[t])r.Views[t]={};if(+a.zoomScale)r.Views[t].zoom=+a.zoomScale;if(a.rightToLeft&&_t(a.rightToLeft))r.Views[t].RTL=true})}function Cl(e,r,t,a){var n={workbookViewId:\"0\"};if((((a||{}).Workbook||{}).Views||[])[0])n.rightToLeft=a.Workbook.Views[0].RTL?\"1\":\"0\";return Bt(\"sheetViews\",Bt(\"sheetView\",null,n),{})}function Sl(e,r,t,a,n,i,s){if(e.c)t[\"!comments\"].push([r,e.c]);if((e.v===undefined||e.t===\"z\"&&!(a||{}).sheetStubs)&&typeof e.f!==\"string\"&&typeof e.z==\"undefined\")return\"\";var l=\"\";var o=e.t,c=e.v;if(e.t!==\"z\")switch(e.t){case\"b\":l=e.v?\"1\":\"0\";break;case\"n\":if(isNaN(e.v)){e.t=\"e\";l=En[e.v=36]}else if(!isFinite(e.v)){e.t=\"e\";l=En[e.v=7]}else l=\"\"+e.v;break;case\"e\":l=En[e.v];break;case\"d\":if(a&&a.cellDates){var f=wr(e.v,s);l=f.toISOString();if(f.getUTCFullYear()<1900)l=l.slice(l.indexOf(\"T\")+1).replace(\"Z\",\"\")}else{e=yr(e);e.t=\"n\";l=\"\"+(e.v=dr(wr(e.v,s),s))}if(typeof e.z===\"undefined\")e.z=q[14];break;default:l=e.v;break;}var u=e.t==\"z\"||e.v==null?\"\":Lt(\"v\",bt(l)),h={r:r};var d=Js(a.cellXfs,e,a);if(d!==0)h.s=d;switch(e.t){case\"n\":break;case\"d\":h.t=\"d\";break;case\"b\":h.t=\"b\";break;case\"e\":h.t=\"e\";break;case\"z\":break;default:if(e.v==null){delete e.t;break}if(e.v.length>32767)throw new Error(\"Text length must not exceed 32767 characters\");if(a&&a.bookSST){u=Lt(\"v\",\"\"+Xs(a.Strings,e.v,a.revStrings));h.t=\"s\";break}else h.t=\"str\";break;}if(e.t!=o){e.t=o;e.v=c}if(typeof e.f==\"string\"&&e.f){var p=e.F&&e.F.slice(0,r.length)==r?{t:\"array\",ref:e.F}:null;u=Bt(\"f\",bt(e.f),p)+(e.v!=null?u:\"\")}if(e.l){e.l.display=bt(l);t[\"!links\"].push([r,e.l])}if(e.D)h.cm=1;return Bt(\"c\",u,h)}var _l=function(){var e=/<(?:\\w+:)?c[ \\/>]/,r=/<\\/(?:\\w+:)?row>/;var t=/r=[\"']([^\"']*)[\"']/;var a=/ref=[\"']([^\"']*)[\"']/;return function n(i,s,l,o,c,f,u){var h=0,d=\"\",p=[],m=[],v=0,g=0,b=0,w=\"\",k;var y,x=0,C=0;var S,_;var A=0,T=0;var E=Array.isArray(f.CellXf),F;var D=[];var O=[];var N=s[\"!data\"]!=null;var M=[],I={},P=false;var R=!!l.sheetStubs;var L=!!((u||{}).WBProps||{}).date1904;for(var U=i.split(r),B=0,z=U.length;B!=z;++B){d=U[B].trim();var $=d.length;if($===0)continue;var W=0;e:for(h=0;h<$;++h)switch(d[h]){case\">\":if(d[h-1]!=\"/\"){++h;break e}if(l&&l.cellStyles){y=ft(d.slice(W,h),true);x=y.r!=null?parseInt(y.r,10):x+1;C=-1;if(l.sheetRows&&l.sheetRows<x)continue;I={};P=false;if(y.ht){P=true;I.hpt=parseFloat(y.ht);I.hpx=Wi(I.hpt)}if(y.hidden&&_t(y.hidden)){P=true;I.hidden=true}if(y.outlineLevel!=null){P=true;I.level=+y.outlineLevel}if(P)M[x-1]=I}break;case\"<\":W=h;break;}if(W>=h)break;y=ft(d.slice(W,h),true);x=y.r!=null?parseInt(y.r,10):x+1;C=-1;if(l.sheetRows&&l.sheetRows<x)continue;if(!l.nodim){if(o.s.r>x-1)o.s.r=x-1;if(o.e.r<x-1)o.e.r=x-1}if(l&&l.cellStyles){I={};P=false;if(y.ht){P=true;I.hpt=parseFloat(y.ht);I.hpx=Wi(I.hpt)}if(y.hidden&&_t(y.hidden)){P=true;I.hidden=true}if(y.outlineLevel!=null){P=true;I.level=+y.outlineLevel}if(P)M[x-1]=I}p=d.slice(h).split(e);for(var j=0;j!=p.length;++j)if(p[j].trim().charAt(0)!=\"<\")break;p=p.slice(j);for(h=0;h!=p.length;++h){d=p[h].trim();if(d.length===0)continue;m=d.match(t);v=h;g=0;b=0;d=\"<c \"+(d.slice(0,1)==\"<\"?\">\":\"\")+d;if(m!=null&&m.length===2){v=0;w=m[1];for(g=0;g!=w.length;++g){if((b=w.charCodeAt(g)-64)<1||b>26)break;v=26*v+b}--v;C=v}else++C;for(g=0;g!=d.length;++g)if(d.charCodeAt(g)===62)break;++g;y=ft(d.slice(0,g),true);if(!y.r)y.r=Ja({r:x-1,c:C});w=d.slice(g);k={t:\"\"};if((m=zr(w,\"v\"))!=null&&m[1]!==\"\")k.v=mt(m[1]);if(l.cellFormula){if((m=zr(w,\"f\"))!=null){if(m[1]==\"\"){if(m[0].indexOf('t=\"shared\"')>-1){_=ft(m[0]);if(O[_.si])k.f=Rs(O[_.si][1],O[_.si][2],y.r)}}else{k.f=mt(Dt(m[1]),true);if(!l.xlfn)k.f=Us(k.f);if(m[0].indexOf('t=\"array\"')>-1){k.F=(w.match(a)||[])[1];if(k.F.indexOf(\":\")>-1)D.push([en(k.F),k.F])}else if(m[0].indexOf('t=\"shared\"')>-1){_=ft(m[0]);var H=mt(Dt(m[1]));if(!l.xlfn)H=Us(H);O[parseInt(_.si,10)]=[_,H,y.r]}}}else if(m=w.match(/<f[^<>]*\\/>/)){_=ft(m[0]);if(O[_.si])k.f=Rs(O[_.si][1],O[_.si][2],y.r)}var V=Ya(y.r);for(g=0;g<D.length;++g)if(V.r>=D[g][0].s.r&&V.r<=D[g][0].e.r)if(V.c>=D[g][0].s.c&&V.c<=D[g][0].e.c)k.F=D[g][1]}if(y.t==null&&k.v===undefined){if(k.f||k.F){k.v=0;k.t=\"n\"}else if(!R)continue;else k.t=\"z\"}else k.t=y.t||\"n\";if(o.s.c>C)o.s.c=C;if(o.e.c<C)o.e.c=C;switch(k.t){case\"n\":if(k.v==\"\"||k.v==null){if(!R)continue;k.t=\"z\"}else k.v=parseFloat(k.v);break;case\"s\":if(typeof k.v==\"undefined\"){if(!R)continue;k.t=\"z\"}else{S=js[parseInt(k.v,10)];k.v=S.t;k.r=S.r;if(l.cellHTML)k.h=S.h}break;case\"str\":k.t=\"s\";k.v=k.v!=null?mt(Dt(k.v),true):\"\";if(l.cellHTML)k.h=yt(k.v);break;case\"inlineStr\":m=zr(w,\"is\");k.t=\"s\";if(m!=null&&(S=bi(m[1]))){k.v=S.t;if(l.cellHTML)k.h=S.h}else k.v=\"\";break;case\"b\":k.v=_t(k.v);break;case\"d\":if(l.cellDates)k.v=wr(k.v,L);else{k.v=dr(wr(k.v,L),L);k.t=\"n\"}break;case\"e\":if(!l||l.cellText!==false)k.w=k.v;k.v=Fn[k.v];break;}A=T=0;F=null;if(E&&y.s!==undefined){F=f.CellXf[y.s];if(F!=null){if(F.numFmtId!=null)A=F.numFmtId;if(l.cellStyles){if(F.fillId!=null)T=F.fillId}}}Zs(k,A,T,l,c,f,L);if(l.cellDates&&E&&k.t==\"n\"&&Re(q[A])){k.v=pr(k.v+(L?1462:0));k.t=typeof k.v==\"number\"?\"n\":\"d\"}if(y.cm&&l.xlmeta){var X=(l.xlmeta.Cell||[])[+y.cm-1];if(X&&X.type==\"XLDAPR\")k.D=true}var G;if(l.nodim){G=Ya(y.r);if(o.s.r>G.r)o.s.r=G.r;if(o.e.r<G.r)o.e.r=G.r}if(N){G=Ya(y.r);if(!s[\"!data\"][G.r])s[\"!data\"][G.r]=[];s[\"!data\"][G.r][G.c]=k}else s[y.r]=k}}if(M.length>0)s[\"!rows\"]=M}}();function Al(e,r,t,a){var n=[],i=[],s=en(e[\"!ref\"]),l=\"\",o,c=\"\",f=[],u=0,h=0,d=e[\"!rows\"];var p=e[\"!data\"]!=null,m=p?e[\"!data\"]:[];var v={r:c},g,b=-1;var w=(((a||{}).Workbook||{}).WBProps||{}).date1904;for(h=s.s.c;h<=s.e.c;++h)f[h]=Ha(h);for(u=s.s.r;u<=s.e.r;++u){i=[];c=za(u);var k=p?m[u]:[];for(h=s.s.c;h<=s.e.c;++h){o=f[h]+c;var y=p?k[h]:e[o];if(y===undefined)continue;if((l=Sl(y,o,e,r,t,a,w))!=null)i.push(l)}if(i.length>0||d&&d[u]){v={r:c};if(d&&d[u]){g=d[u];if(g.hidden)v.hidden=1;b=-1;if(g.hpx)b=$i(g.hpx);else if(g.hpt)b=g.hpt;if(b>-1){v.ht=b;v.customHeight=1}if(g.level){v.outlineLevel=g.level}}n[n.length]=Bt(\"row\",i.join(\"\"),v)}}if(d)for(;u<d.length;++u){if(d&&d[u]){v={r:u+1};g=d[u];if(g.hidden)v.hidden=1;b=-1;if(g.hpx)b=$i(g.hpx);else if(g.hpt)b=g.hpt;if(b>-1){v.ht=b;v.customHeight=1}if(g.level){v.outlineLevel=g.level}n[n.length]=Bt(\"row\",\"\",v)}}return n.join(\"\")}function Tl(e,r,t,a){var n=[at,Bt(\"worksheet\",null,{xmlns:Vt[0],\"xmlns:r\":Ht.r})];var i=t.SheetNames[e],s=0,l=\"\";var o=t.Sheets[i];if(o==null)o={};var c=o[\"!ref\"]||\"A1\";var f=en(c);if(f.e.c>16383||f.e.r>1048575){if(r.WTF)throw new Error(\"Range \"+c+\" exceeds format limit A1:XFD1048576\");f.e.c=Math.min(f.e.c,16383);f.e.r=Math.min(f.e.c,1048575);c=Ka(f)}if(!a)a={};o[\"!comments\"]=[];var u=[];fl(o,t,e,r,n);n[n.length]=Bt(\"dimension\",null,{ref:c});n[n.length]=Cl(o,r,e,t);if(r.sheetFormat)n[n.length]=Bt(\"sheetFormatPr\",null,{defaultRowHeight:r.sheetFormat.defaultRowHeight||\"16\",baseColWidth:r.sheetFormat.baseColWidth||\"10\",outlineLevelRow:r.sheetFormat.outlineLevelRow||\"7\"});if(o[\"!cols\"]!=null&&o[\"!cols\"].length>0)n[n.length]=bl(o,o[\"!cols\"]);n[s=n.length]=\"<sheetData/>\";o[\"!links\"]=[];if(o[\"!ref\"]!=null){l=Al(o,r,e,t,a);if(l.length>0)n[n.length]=l}if(n.length>s+1){n[n.length]=\"</sheetData>\";n[s]=n[s].replace(\"/>\",\">\")}if(o[\"!protect\"])n[n.length]=dl(o[\"!protect\"]);if(o[\"!autofilter\"]!=null)n[n.length]=kl(o[\"!autofilter\"],o,t,e);if(o[\"!merges\"]!=null&&o[\"!merges\"].length>0)n[n.length]=ll(o[\"!merges\"]);var h=-1,d,p=-1;if(o[\"!links\"].length>0){n[n.length]=\"<hyperlinks>\";o[\"!links\"].forEach(function(e){if(!e[1].Target)return;d={ref:e[0]};if(e[1].Target.charAt(0)!=\"#\"){p=zn(a,-1,bt(e[1].Target).replace(/#[\\s\\S]*$/,\"\"),Rn.HLINK);d[\"r:id\"]=\"rId\"+p}if((h=e[1].Target.indexOf(\"#\"))>-1)d.location=bt(e[1].Target.slice(h+1));if(e[1].Tooltip)d.tooltip=bt(e[1].Tooltip);d.display=e[1].display;n[n.length]=Bt(\"hyperlink\",null,d)});n[n.length]=\"</hyperlinks>\"}delete o[\"!links\"];if(o[\"!margins\"]!=null)n[n.length]=vl(o[\"!margins\"]);if(!r||r.ignoreEC||r.ignoreEC==void 0)n[n.length]=Lt(\"ignoredErrors\",Bt(\"ignoredError\",null,{numberStoredAsText:1,sqref:c}));if(u.length>0){p=zn(a,-1,\"../drawings/drawing\"+(e+1)+\".xml\",Rn.DRAW);n[n.length]=Bt(\"drawing\",null,{\"r:id\":\"rId\"+p});o[\"!drawing\"]=u}if(o[\"!comments\"].length>0){p=zn(a,-1,\"../drawings/vmlDrawing\"+(e+1)+\".vml\",Rn.VML);n[n.length]=Bt(\"legacyDrawing\",null,{\"r:id\":\"rId\"+p});o[\"!legacy\"]=p}if(n.length>1){n[n.length]=\"</worksheet>\";n[1]=n[1].replace(\"/>\",\">\")}return n.join(\"\")}function El(e){var r=[];var t=e.match(/^<c:numCache>/);var a;(e.match(/<c:pt idx=\"(\\d*)\"[^<>\\/]*><c:v>([^<])<\\/c:v><\\/c:pt>/gm)||[]).forEach(function(e){var a=e.match(/<c:pt idx=\"(\\d*)\"[^<>\\/]*><c:v>([^<]*)<\\/c:v><\\/c:pt>/);if(!a)return;r[+a[1]]=t?+a[2]:a[2]});var n=mt((Br(e,\"c:formatCode\")||[\"\",\"General\"])[1]);(Rr(e,\"<c:f>\",\"</c:f>\")||[]).forEach(function(e){a=e.replace(/<[^<>]*>/g,\"\")});return[r,n,a]}function Fl(e,r,t,a,n,i){var s=i||{\"!type\":\"chart\"};if(!e)return i;var l=0,o=0,c=\"A\";var f={s:{r:2e6,c:2e6},e:{r:0,c:0}};(Rr(e,\"<c:numCache>\",\"</c:numCache>\")||[]).forEach(function(e){var r=El(e);f.s.r=f.s.c=0;f.e.c=l;c=Ha(l);r[0].forEach(function(e,t){if(s[\"!data\"]){if(!s[\"!data\"][t])s[\"!data\"][t]=[];s[\"!data\"][t][l]={t:\"n\",v:e,z:r[1]}}else s[c+za(t)]={t:\"n\",v:e,z:r[1]};o=t});if(f.e.r<o)f.e.r=o;++l});if(l>0)s[\"!ref\"]=Ka(f);return s}function Dl(e,r,t,a,n){if(!e)return e;if(!a)a={\"!id\":{}};var i={\"!type\":\"chart\",\"!drawel\":null,\"!rel\":\"\"};var s;var l=e.match(il);if(l)ol(l[0],i,n,t);if(s=e.match(/drawing r:id=\"(.*?)\"/))i[\"!rel\"]=s[1];if(a[\"!id\"][i[\"!rel\"]])i[\"!drawel\"]=a[\"!id\"][i[\"!rel\"]];return i}var Ol=[[\"allowRefreshQuery\",false,\"bool\"],[\"autoCompressPictures\",true,\"bool\"],[\"backupFile\",false,\"bool\"],[\"checkCompatibility\",false,\"bool\"],[\"CodeName\",\"\"],[\"date1904\",false,\"bool\"],[\"defaultThemeVersion\",0,\"int\"],[\"filterPrivacy\",false,\"bool\"],[\"hidePivotFieldList\",false,\"bool\"],[\"promptedSolutions\",false,\"bool\"],[\"publishItems\",false,\"bool\"],[\"refreshAllConnections\",false,\"bool\"],[\"saveExternalLinkValues\",true,\"bool\"],[\"showBorderUnselectedTables\",true,\"bool\"],[\"showInkAnnotation\",true,\"bool\"],[\"showObjects\",\"all\"],[\"showPivotChartFilter\",false,\"bool\"],[\"updateLinks\",\"userSet\"]];var Nl=[[\"activeTab\",0,\"int\"],[\"autoFilterDateGrouping\",true,\"bool\"],[\"firstSheet\",0,\"int\"],[\"minimized\",false,\"bool\"],[\"showHorizontalScroll\",true,\"bool\"],[\"showSheetTabs\",true,\"bool\"],[\"showVerticalScroll\",true,\"bool\"],[\"tabRatio\",600,\"int\"],[\"visibility\",\"visible\"]];var Ml=[];var Il=[[\"calcCompleted\",\"true\"],[\"calcMode\",\"auto\"],[\"calcOnSave\",\"true\"],[\"concurrentCalc\",\"true\"],[\"fullCalcOnLoad\",\"false\"],[\"fullPrecision\",\"true\"],[\"iterate\",\"false\"],[\"iterateCount\",\"100\"],[\"iterateDelta\",\"0.001\"],[\"refMode\",\"A1\"]];function Pl(e,r){for(var t=0;t!=e.length;++t){var a=e[t];for(var n=0;n!=r.length;++n){var i=r[n];if(a[i[0]]==null)a[i[0]]=i[1];else switch(i[2]){case\"bool\":if(typeof a[i[0]]==\"string\")a[i[0]]=_t(a[i[0]]);break;case\"int\":if(typeof a[i[0]]==\"string\")a[i[0]]=parseInt(a[i[0]],10);break;}}}}function Rl(e,r){for(var t=0;t!=r.length;++t){var a=r[t];if(e[a[0]]==null)e[a[0]]=a[1];else switch(a[2]){case\"bool\":if(typeof e[a[0]]==\"string\")e[a[0]]=_t(e[a[0]]);break;case\"int\":if(typeof e[a[0]]==\"string\")e[a[0]]=parseInt(e[a[0]],10);break;}}}function Ll(e){Rl(e.WBProps,Ol);Rl(e.CalcPr,Il);Pl(e.WBView,Nl);Pl(e.Sheets,Ml);Hs.date1904=_t(e.WBProps.date1904)}function Ul(e){if(!e.Workbook)return\"false\";if(!e.Workbook.WBProps)return\"false\";return _t(e.Workbook.WBProps.date1904)?\"true\":\"false\"}var Bl=\":][*?/\\\\\".split(\"\");function zl(e,r){try{if(e==\"\")throw new Error(\"Sheet name cannot be blank\");if(e.length>31)throw new Error(\"Sheet name cannot exceed 31 chars\");if(e.charCodeAt(0)==39||e.charCodeAt(e.length-1)==39)throw new Error(\"Sheet name cannot start or end with apostrophe (')\");if(e.toLowerCase()==\"history\")throw new Error(\"Sheet name cannot be 'History'\");Bl.forEach(function(r){if(e.indexOf(r)==-1)return;throw new Error(\"Sheet name cannot contain : \\\\ / ? * [ ]\")})}catch(t){if(r)return false;throw t}return true}function $l(e,r,t){e.forEach(function(a,n){zl(a);for(var i=0;i<n;++i)if(a==e[i])throw new Error(\"Duplicate Sheet Name: \"+a);if(t){var s=r&&r[n]&&r[n].CodeName||a;if(s.charCodeAt(0)==95&&s.length>22)throw new Error(\"Bad Code Name: Worksheet\"+s)}})}function Wl(e){if(!e||!e.SheetNames||!e.Sheets)throw new Error(\"Invalid Workbook\");if(!e.SheetNames.length)throw new Error(\"Workbook is empty\");var r=e.Workbook&&e.Workbook.Sheets||[];$l(e.SheetNames,r,!!e.vbaraw);for(var t=0;t<e.SheetNames.length;++t)Ks(e.Sheets[e.SheetNames[t]],e.SheetNames[t],t);e.SheetNames.forEach(function(r,t){var a=e.Sheets[r];if(!a||!a[\"!autofilter\"])return;var n;if(!e.Workbook)e.Workbook={};if(!e.Workbook.Names)e.Workbook.Names=[];e.Workbook.Names.forEach(function(e){if(e.Name==\"_xlnm._FilterDatabase\"&&e.Sheet==t)n=e});var i=Qa(r)+\"!\"+qa(a[\"!autofilter\"].ref);if(n)n.Ref=i;else e.Workbook.Names.push({Name:\"_xlnm._FilterDatabase\",Sheet:t,Ref:i})})}var jl=/<\\w+:workbook/;function Hl(e,r){if(!e)throw new Error(\"Could not find file\");var t={AppVersion:{},WBProps:{},WBView:[],Sheets:[],CalcPr:{},Names:[],xmlns:\"\"};var a=false,n=\"xmlns\";var i={},s=0;e.replace(lt,function l(o,c){var f=ft(o);switch(ht(f[0])){case\"<?xml\":break;case\"<workbook\":if(o.match(jl))n=\"xmlns\"+o.match(/<(\\w+):/)[1];t.xmlns=f[n];break;case\"</workbook>\":break;case\"<fileVersion\":delete f[0];t.AppVersion=f;break;case\"<fileVersion/>\":;case\"</fileVersion>\":break;case\"<fileSharing\":break;case\"<fileSharing/>\":break;case\"<workbookPr\":;case\"<workbookPr/>\":Ol.forEach(function(e){if(f[e[0]]==null)return;switch(e[2]){case\"bool\":t.WBProps[e[0]]=_t(f[e[0]]);break;case\"int\":t.WBProps[e[0]]=parseInt(f[e[0]],10);break;default:t.WBProps[e[0]]=f[e[0]];}});if(f.codeName)t.WBProps.CodeName=Dt(f.codeName);break;case\"</workbookPr>\":break;case\"<workbookProtection\":break;case\"<workbookProtection/>\":break;case\"<bookViews\":;case\"<bookViews>\":;case\"</bookViews>\":break;case\"<workbookView\":;case\"<workbookView/>\":delete f[0];t.WBView.push(f);break;case\"</workbookView>\":break;case\"<sheets\":;case\"<sheets>\":;case\"</sheets>\":break;case\"<sheet\":switch(f.state){case\"hidden\":f.Hidden=1;break;case\"veryHidden\":f.Hidden=2;break;default:f.Hidden=0;}delete f.state;f.name=mt(Dt(f.name));delete f[0];t.Sheets.push(f);break;case\"</sheet>\":break;case\"<functionGroups\":;case\"<functionGroups/>\":break;case\"<functionGroup\":break;case\"<externalReferences\":;case\"</externalReferences>\":;case\"<externalReferences>\":break;case\"<externalReference\":break;case\"<definedNames/>\":break;case\"<definedNames>\":;case\"<definedNames\":a=true;break;case\"</definedNames>\":a=false;break;case\"<definedName\":{i={};i.Name=Dt(f.name);if(f.comment)i.Comment=f.comment;if(f.localSheetId)i.Sheet=+f.localSheetId;if(_t(f.hidden||\"0\"))i.Hidden=true;s=c+o.length}break;case\"</definedName>\":{i.Ref=mt(Dt(e.slice(s,c)));t.Names.push(i)}break;case\"<definedName/>\":break;case\"<calcPr\":delete f[0];t.CalcPr=f;break;case\"<calcPr/>\":delete f[0];t.CalcPr=f;break;case\"</calcPr>\":break;case\"<oleSize\":break;case\"<customWorkbookViews>\":;case\"</customWorkbookViews>\":;case\"<customWorkbookViews\":break;case\"<customWorkbookView\":;case\"</customWorkbookView>\":break;case\"<pivotCaches>\":;case\"</pivotCaches>\":;case\"<pivotCaches\":break;case\"<pivotCache\":break;case\"<smartTagPr\":;case\"<smartTagPr/>\":break;case\"<smartTagTypes\":;case\"<smartTagTypes>\":;case\"</smartTagTypes>\":break;case\"<smartTagType\":break;case\"<webPublishing\":;case\"<webPublishing/>\":break;case\"<fileRecoveryPr\":;case\"<fileRecoveryPr/>\":break;case\"<webPublishObjects>\":;case\"<webPublishObjects\":;case\"</webPublishObjects>\":break;case\"<webPublishObject\":break;case\"<extLst\":;case\"<extLst>\":;case\"</extLst>\":;case\"<extLst/>\":break;case\"<ext\":a=true;break;case\"</ext>\":a=false;break;case\"<ArchID\":break;case\"<AlternateContent\":;case\"<AlternateContent>\":a=true;break;case\"</AlternateContent>\":a=false;break;case\"<revisionPtr\":break;default:if(!a&&r.WTF)throw new Error(\"unrecognized \"+f[0]+\" in workbook\");}return o});if(Vt.indexOf(t.xmlns)===-1)throw new Error(\"Unknown Namespace: \"+t.xmlns);Ll(t);return t}function Vl(e){var r=[at];r[r.length]=Bt(\"workbook\",null,{xmlns:Vt[0],\"xmlns:r\":Ht.r});var t=e.Workbook&&(e.Workbook.Names||[]).length>0;var a={codeName:\"ThisWorkbook\"};if(e.Workbook&&e.Workbook.WBProps){Ol.forEach(function(r){if(e.Workbook.WBProps[r[0]]==null)return;if(e.Workbook.WBProps[r[0]]==r[1])return;a[r[0]]=e.Workbook.WBProps[r[0]]});if(e.Workbook.WBProps.CodeName){a.codeName=e.Workbook.WBProps.CodeName;delete a.CodeName}}r[r.length]=Bt(\"workbookPr\",null,a);var n=e.Workbook&&e.Workbook.Sheets||[];var i=0;if(n&&n[0]&&!!n[0].Hidden){r[r.length]=\"<bookViews>\";for(i=0;i!=e.SheetNames.length;++i){if(!n[i])break;if(!n[i].Hidden)break}if(i==e.SheetNames.length)i=0;r[r.length]='<workbookView firstSheet=\"'+i+'\" activeTab=\"'+i+'\"/>';r[r.length]=\"</bookViews>\"}r[r.length]=\"<sheets>\";for(i=0;i!=e.SheetNames.length;++i){var s={name:bt(e.SheetNames[i].slice(0,31))};s.sheetId=\"\"+(i+1);s[\"r:id\"]=\"rId\"+(i+1);if(n[i])switch(n[i].Hidden){case 1:s.state=\"hidden\";break;case 2:s.state=\"veryHidden\";break;}r[r.length]=Bt(\"sheet\",null,s)}r[r.length]=\"</sheets>\";if(t){r[r.length]=\"<definedNames>\";if(e.Workbook&&e.Workbook.Names)e.Workbook.Names.forEach(function(e){var t={name:e.Name};if(e.Comment)t.comment=e.Comment;if(e.Sheet!=null)t.localSheetId=\"\"+e.Sheet;if(e.Hidden)t.hidden=\"1\";if(!e.Ref)return;r[r.length]=Bt(\"definedName\",bt(e.Ref),t)});r[r.length]=\"</definedNames>\"}if(r.length>2){r[r.length]=\"</workbook>\";r[1]=r[1].replace(\"/>\",\">\")}return r.join(\"\")}function Xl(e,r,t){if(r.slice(-4)===\".bin\")return parse_wb_bin(e,t);return Hl(e,t)}function Gl(e,r,t,a,n,i,s,l){if(r.slice(-4)===\".bin\")return parse_ws_bin(e,a,t,n,i,s,l);return sl(e,a,t,n,i,s,l)}function Yl(e,r,t,a,n,i,s,l){if(r.slice(-4)===\".bin\")return parse_cs_bin(e,a,t,n,i,s,l);return Dl(e,a,t,n,i,s,l)}function Jl(e,r,t,a,n,i,s,l){if(r.slice(-4)===\".bin\")return Fs(e,a,t,n,i,s,l);return Ds(e,a,t,n,i,s,l)}function Zl(e,r,t,a,n,i,s,l){if(r.slice(-4)===\".bin\")return Ts(e,a,t,n,i,s,l);return Es(e,a,t,n,i,s,l)}function Kl(e,r,t,a){if(r.slice(-4)===\".bin\")return parse_sty_bin(e,t,a);return Qi(e,t,a)}function ql(e,r,t){if(r.slice(-4)===\".bin\")return parse_sst_bin(e,t);return yi(e,t)}function Ql(e,r,t){if(r.slice(-4)===\".bin\")return parse_comments_bin(e,t);return gs(e,t)}function eo(e,r,t){if(r.slice(-4)===\".bin\")return parse_cc_bin(e,r,t);return parse_cc_xml(e,r,t)}function ro(e,r,t,a){if(t.slice(-4)===\".bin\")return us(e,r,t,a);return fs(e,r,t,a)}function to(e,r,t){if(r.slice(-4)===\".bin\")return parse_xlmeta_bin(e,r,t);return os(e,r,t)}function ao(e,r){var t=r||{};var a=t.dense!=null?t.dense:b;var n={};if(a)n[\"!data\"]=[];e=Lr(e,\"<!--\",\"-->\");var i=e.match(/<table/i);if(!i)throw new Error(\"Invalid HTML: could not find <table>\");var s=e.match(/<\\/table/i);var l=i.index,o=s&&s.index||e.length;var c=Nr(e.slice(l,o),/(:?<tr[^<>]*>)/i,\"<tr>\");var f=-1,u=0,h=0,d=0;var p={s:{r:1e7,c:1e7},e:{r:0,c:0}};var m=[];for(l=0;l<c.length;++l){var v=c[l].trim();var g=v.slice(0,3).toLowerCase();if(g==\"<tr\"){++f;if(t.sheetRows&&t.sheetRows<=f){--f;break}u=0;continue}if(g!=\"<td\"&&g!=\"<th\")continue;var w=v.split(/<\\/t[dh]>/i);for(o=0;o<w.length;++o){var k=w[o].trim();if(!k.match(/<t[dh]/i))continue;var y=k,x=0;while(y.charAt(0)==\"<\"&&(x=y.indexOf(\">\"))>-1)y=y.slice(x+1);for(var C=0;C<m.length;++C){var S=m[C];if(S.s.c==u&&S.s.r<f&&f<=S.e.r){u=S.e.c+1;C=-1}}var _=ft(k.slice(0,k.indexOf(\">\")));d=_.colspan?+_.colspan:1;if((h=+_.rowspan)>1||d>1)m.push({s:{r:f,c:u},e:{r:f+(h||1)-1,c:u+d-1}});var A=_.t||_[\"data-t\"]||\"\";if(!y.length){u+=d;continue}y=Nt(y);if(p.s.r>f)p.s.r=f;if(p.e.r<f)p.e.r=f;if(p.s.c>u)p.s.c=u;if(p.e.c<u)p.e.c=u;if(!y.length){u+=d;continue}var T={t:\"s\",v:y};if(t.raw||!y.trim().length||A==\"s\"){}else if(y===\"TRUE\")T={t:\"b\",v:true};else if(y===\"FALSE\")T={t:\"b\",v:false};else if(!isNaN(Cr(y)))T={t:\"n\",v:Cr(y)};else if(!isNaN(Or(y).getDate())){T={t:\"d\",v:wr(y)};if(t.UTC===false)T.v=Mr(T.v);if(!t.cellDates)T={t:\"n\",v:dr(T.v)};T.z=t.dateNF||q[14]}else if(y.charCodeAt(0)==35&&Fn[y]!=null){T.t=\"e\";T.w=y;T.v=Fn[y]}if(T.cellText!==false)T.w=y;if(a){if(!n[\"!data\"][f])n[\"!data\"][f]=[];n[\"!data\"][f][u]=T}else n[Ja({r:f,c:u})]=T;u+=d}}n[\"!ref\"]=Ka(p);if(m.length)n[\"!merges\"]=m;return n}function no(e,r,t,a){var n=e[\"!merges\"]||[];var i=[];var s={};var l=e[\"!data\"]!=null;for(var o=r.s.c;o<=r.e.c;++o){var c=0,f=0;for(var u=0;u<n.length;++u){if(n[u].s.r>t||n[u].s.c>o)continue;if(n[u].e.r<t||n[u].e.c<o)continue;if(n[u].s.r<t||n[u].s.c<o){c=-1;break}c=n[u].e.r-n[u].s.r+1;f=n[u].e.c-n[u].s.c+1;break}if(c<0)continue;var h=Ha(o)+za(t);var d=l?(e[\"!data\"][t]||[])[o]:e[h];if(d&&d.t==\"n\"&&d.v!=null&&!isFinite(d.v)){if(isNaN(d.v))d={t:\"e\",v:36,w:En[36]};else d={t:\"e\",v:7,w:En[7]}}var p=d&&d.v!=null&&(d.h||yt(d.w||(tn(d),d.w)||\"\"))||\"\";s={};if(c>1)s.rowspan=c;if(f>1)s.colspan=f;if(a.editable)p='<span contenteditable=\"true\">'+p+\"</span>\";else if(d){s[\"data-t\"]=d&&d.t||\"z\";if(d.v!=null)s[\"data-v\"]=yt(d.v instanceof Date?d.v.toISOString():d.v);if(d.z!=null)s[\"data-z\"]=d.z;if(d.l&&(d.l.Target||\"#\").charAt(0)!=\"#\")p='<a href=\"'+yt(d.l.Target)+'\">'+p+\"</a>\"}s.id=(a.id||\"sjs\")+\"-\"+h;i.push(Bt(\"td\",p,s))}var m=\"<tr>\";return m+i.join(\"\")+\"</tr>\"}var io='<html><head><meta charset=\"utf-8\"/><title>SheetJS Table Export</title></head><body>';var so=\"</body></html>\";function lo(e,r){var t=jr(e,\"table\");if(!t||t.length==0)throw new Error(\"Invalid HTML: could not find <table>\");if(t.length==1){var a=an(ao(t[0],r),r);a.bookType=\"html\";return a}var n=kc();t.forEach(function(e,t){yc(n,ao(e,r),\"Sheet\"+(t+1))});n.bookType=\"html\";return n}function oo(e,r,t){var a=[];return a.join(\"\")+\"<table\"+(t&&t.id?' id=\"'+t.id+'\"':\"\")+\">\"}function co(e,r){var t=r||{};var a=t.header!=null?t.header:io;var n=t.footer!=null?t.footer:so;var i=[a];var s=Za(e[\"!ref\"]||\"A1\");i.push(oo(e,s,t));if(e[\"!ref\"])for(var l=s.s.r;l<=s.e.r;++l)i.push(no(e,s,l,t));i.push(\"</table>\"+n);return i.join(\"\")}function fo(e,r,t){var a=r.rows;if(!a){throw\"Unsupported origin when \"+r.tagName+\" is not a TABLE\"}var n=t||{};var i=e[\"!data\"]!=null;var s=0,l=0;if(n.origin!=null){if(typeof n.origin==\"number\")s=n.origin;else{var o=typeof n.origin==\"string\"?Ya(n.origin):n.origin;s=o.r;l=o.c}}var c=Math.min(n.sheetRows||1e7,a.length);var f={s:{r:0,c:0},e:{r:s,c:l}};if(e[\"!ref\"]){var u=Za(e[\"!ref\"]);f.s.r=Math.min(f.s.r,u.s.r);f.s.c=Math.min(f.s.c,u.s.c);f.e.r=Math.max(f.e.r,u.e.r);f.e.c=Math.max(f.e.c,u.e.c);if(s==-1)f.e.r=s=u.e.r+1}var h=[],d=0;var p=e[\"!rows\"]||(e[\"!rows\"]=[]);var m=0,v=0,g=0,b=0,w=0,k=0;if(!e[\"!cols\"])e[\"!cols\"]=[];for(;m<a.length&&v<c;++m){var y=a[m];if(po(y)){if(n.display)continue;p[v]={hidden:true}}var x=y.cells;for(g=b=0;g<x.length;++g){var C=x[g];if(n.display&&po(C))continue;var S=C.hasAttribute(\"data-v\")?C.getAttribute(\"data-v\"):C.hasAttribute(\"v\")?C.getAttribute(\"v\"):Nt(C.innerHTML);var _=C.getAttribute(\"data-z\")||C.getAttribute(\"z\");for(d=0;d<h.length;++d){var A=h[d];if(A.s.c==b+l&&A.s.r<v+s&&v+s<=A.e.r){b=A.e.c+1-l;d=-1}}k=+C.getAttribute(\"colspan\")||1;if((w=+C.getAttribute(\"rowspan\")||1)>1||k>1)h.push({s:{r:v+s,c:b+l},e:{r:v+s+(w||1)-1,c:b+l+(k||1)-1}});var T={t:\"s\",v:S};var E=C.getAttribute(\"data-t\")||C.getAttribute(\"t\")||\"\";if(S!=null){if(S.length==0)T.t=E||\"z\";else if(n.raw||S.trim().length==0||E==\"s\"){}else if(E==\"e\"&&En[+S])T={t:\"e\",v:+S,w:En[+S]};else if(S===\"TRUE\")T={t:\"b\",v:true};else if(S===\"FALSE\")T={t:\"b\",v:false};else if(!isNaN(Cr(S)))T={t:\"n\",v:Cr(S)};else if(!isNaN(Or(S).getDate())){T={t:\"d\",v:wr(S)};if(n.UTC)T.v=Ir(T.v);if(!n.cellDates)T={t:\"n\",v:dr(T.v)};T.z=n.dateNF||q[14]}else if(S.charCodeAt(0)==35&&Fn[S]!=null)T={t:\"e\",v:Fn[S],w:S}}if(T.z===undefined&&_!=null)T.z=_;var F=\"\",D=C.getElementsByTagName(\"A\");if(D&&D.length)for(var O=0;O<D.length;++O)if(D[O].hasAttribute(\"href\")){F=D[O].getAttribute(\"href\");if(F.charAt(0)!=\"#\")break}if(F&&F.charAt(0)!=\"#\"&&F.slice(0,11).toLowerCase()!=\"javascript:\")T.l={Target:F};if(i){if(!e[\"!data\"][v+s])e[\"!data\"][v+s]=[];e[\"!data\"][v+s][b+l]=T}else e[Ja({c:b+l,r:v+s})]=T;if(f.e.c<b+l)f.e.c=b+l;b+=k}++v}if(h.length)e[\"!merges\"]=(e[\"!merges\"]||[]).concat(h);f.e.r=Math.max(f.e.r,v-1+s);e[\"!ref\"]=Ka(f);if(v>=c)e[\"!fullref\"]=Ka((f.e.r=a.length-m+v-1+s,f));return e}function uo(e,r){var t=r||{};var a={};if(t.dense)a[\"!data\"]=[];return fo(a,e,r)}function ho(e,r){var t=an(uo(e,r),r);return t}function po(e){var r=\"\";var t=mo(e);if(t)r=t(e).getPropertyValue(\"display\");if(!r)r=e.style&&e.style.display;return r===\"none\"}function mo(e){if(e.ownerDocument.defaultView&&typeof e.ownerDocument.defaultView.getComputedStyle===\"function\")return e.ownerDocument.defaultView.getComputedStyle;if(typeof getComputedStyle===\"function\")return getComputedStyle;return null}function vo(e){var r=e.replace(/[\\t\\r\\n]/g,\" \").trim().replace(/ +/g,\" \").replace(/<text:s\\/>/g,\" \").replace(/<text:s text:c=\"(\\d+)\"\\/>/g,function(e,r){return Array(parseInt(r,10)+1).join(\" \")}).replace(/<text:tab[^<>]*\\/>/g,\"\\t\").replace(/<text:line-break\\/>/g,\"\\n\");var t=mt(r.replace(/<[^<>]*>/g,\"\"));return[t]}function go(e,r,t){var a=t||{};var n=Wt(e);jt.lastIndex=0;n=Pr(Lr(n,\"<!--\",\"-->\"));var i,s,l=\"\",o=\"\",c,f=0,u=-1,h=false,d=\"\";while(i=jt.exec(n)){switch(i[3]=i[3].replace(/_[\\s\\S]*$/,\"\")){case\"number-style\":;case\"currency-style\":;case\"percentage-style\":;case\"date-style\":;case\"time-style\":;case\"text-style\":if(i[1]===\"/\"){h=false;if(s[\"truncate-on-overflow\"]==\"false\"){if(l.match(/h/))l=l.replace(/h+/,\"[$&]\");else if(l.match(/m/))l=l.replace(/m+/,\"[$&]\");else if(l.match(/s/))l=l.replace(/s+/,\"[$&]\")}a[s.name]=l;l=\"\"}else if(i[0].charAt(i[0].length-2)!==\"/\"){h=true;l=\"\";s=ft(i[0],false)}break;case\"boolean-style\":if(i[1]===\"/\"){h=false;a[s.name]=\"General\";l=\"\"}else if(i[0].charAt(i[0].length-2)!==\"/\"){h=true;l=\"\";s=ft(i[0],false)}break;case\"boolean\":l+=\"General\";break;case\"text\":if(i[1]===\"/\"){d=n.slice(u,jt.lastIndex-i[0].length);if(d==\"%\"&&s[0]==\"<number:percentage-style\")l+=\"%\";else l+='\"'+d.replace(/\"/g,'\"\"')+'\"'}else if(i[0].charAt(i[0].length-2)!==\"/\"){u=jt.lastIndex}break;case\"day\":{c=ft(i[0],false);switch(c[\"style\"]){case\"short\":l+=\"d\";break;case\"long\":l+=\"dd\";break;default:l+=\"dd\";break;}}break;case\"day-of-week\":{c=ft(i[0],false);switch(c[\"style\"]){case\"short\":l+=\"ddd\";break;case\"long\":l+=\"dddd\";break;default:l+=\"ddd\";break;}}break;case\"era\":{c=ft(i[0],false);switch(c[\"style\"]){case\"short\":l+=\"ee\";break;case\"long\":l+=\"eeee\";break;default:l+=\"eeee\";break;}}break;case\"hours\":{c=ft(i[0],false);switch(c[\"style\"]){case\"short\":l+=\"h\";break;case\"long\":l+=\"hh\";break;default:l+=\"hh\";break;}}break;case\"minutes\":{c=ft(i[0],false);switch(c[\"style\"]){case\"short\":l+=\"m\";break;case\"long\":l+=\"mm\";break;default:l+=\"mm\";break;}}break;case\"month\":{c=ft(i[0],false);if(c[\"textual\"])l+=\"mm\";switch(c[\"style\"]){case\"short\":l+=\"m\";break;case\"long\":l+=\"mm\";break;default:l+=\"m\";break;}}break;case\"seconds\":{c=ft(i[0],false);switch(c[\"style\"]){case\"short\":l+=\"s\";break;case\"long\":l+=\"ss\";break;default:l+=\"ss\";break;}if(c[\"decimal-places\"])l+=\".\"+xr(\"0\",+c[\"decimal-places\"])}break;case\"year\":{c=ft(i[0],false);switch(c[\"style\"]){case\"short\":l+=\"yy\";break;case\"long\":l+=\"yyyy\";break;default:l+=\"yy\";break;}}break;case\"am-pm\":l+=\"AM/PM\";break;case\"week-of-year\":;case\"quarter\":console.error(\"Excel does not support ODS format token \"+i[3]);break;case\"fill-character\":if(i[1]===\"/\"){d=n.slice(u,jt.lastIndex-i[0].length);l+='\"'+d.replace(/\"/g,'\"\"')+'\"*'}else if(i[0].charAt(i[0].length-2)!==\"/\"){u=jt.lastIndex}break;case\"scientific-number\":c=ft(i[0],false);l+=\"0.\"+xr(\"0\",+c[\"min-decimal-places\"]||+c[\"decimal-places\"]||2)+xr(\"?\",+c[\"decimal-places\"]-+c[\"min-decimal-places\"]||0)+\"E\"+(_t(c[\"forced-exponent-sign\"])?\"+\":\"\")+xr(\"0\",+c[\"min-exponent-digits\"]||2);break;case\"fraction\":c=ft(i[0],false);if(!+c[\"min-integer-digits\"])l+=\"#\";else l+=xr(\"0\",+c[\"min-integer-digits\"]);l+=\" \";l+=xr(\"?\",+c[\"min-numerator-digits\"]||1);l+=\"/\";if(+c[\"denominator-value\"])l+=c[\"denominator-value\"];else l+=xr(\"?\",+c[\"min-denominator-digits\"]||1);break;case\"currency-symbol\":if(i[1]===\"/\"){l+='\"'+n.slice(u,jt.lastIndex-i[0].length).replace(/\"/g,'\"\"')+'\"'}else if(i[0].charAt(i[0].length-2)!==\"/\"){u=jt.lastIndex}else l+=\"$\";break;case\"text-properties\":c=ft(i[0],false);switch((c[\"color\"]||\"\").toLowerCase().replace(\"#\",\"\")){case\"ff0000\":;case\"red\":l=\"[Red]\"+l;break;}break;case\"text-content\":l+=\"@\";break;case\"map\":c=ft(i[0],false);if(mt(c[\"condition\"])==\"value()>=0\")l=a[c[\"apply-style-name\"]]+\";\"+l;else console.error(\"ODS number format may be incorrect: \"+c[\"condition\"]);break;case\"number\":if(i[1]===\"/\")break;c=ft(i[0],false);o=\"\";o+=xr(\"0\",+c[\"min-integer-digits\"]||1);if(_t(c[\"grouping\"]))o=he(xr(\"#\",Math.max(0,4-o.length))+o);if(+c[\"min-decimal-places\"]||+c[\"decimal-places\"])o+=\".\";if(+c[\"min-decimal-places\"])o+=xr(\"0\",+c[\"min-decimal-places\"]||1);if(+c[\"decimal-places\"]-(+c[\"min-decimal-places\"]||0))o+=xr(\"0\",+c[\"decimal-places\"]-(+c[\"min-decimal-places\"]||0));l+=o;break;case\"embedded-text\":if(i[1]===\"/\"){if(f==0)l+='\"'+n.slice(u,jt.lastIndex-i[0].length).replace(/\"/g,'\"\"')+'\"';else l=l.slice(0,f)+'\"'+n.slice(u,jt.lastIndex-i[0].length).replace(/\"/g,'\"\"')+'\"'+l.slice(f)}else if(i[0].charAt(i[0].length-2)!==\"/\"){u=jt.lastIndex;f=-+ft(i[0],false)[\"position\"]||0}break;}}return a}function bo(e,r,t){var a=r||{};if(b!=null&&a.dense==null)a.dense=b;var n=Wt(e);var i=[],s;var l;var o,c=\"\",f=0;var u;var h;var d={},p=[];var m={};if(a.dense)m[\"!data\"]=[];var v,g;var w={value:\"\"},k={};var y=\"\",x=0,C,S=\"\",_=0;var A=[],T=[];var E=-1,F=-1,D={s:{r:1e6,c:1e7},e:{r:0,c:0}};var O=0;var N=t||{},M={};var I=[],P={},R=0,L=0;var U=[],B=1,z=1;var $=[];var W={Names:[],WBProps:{}};var j={};var H=[\"\",\"\"];var V=[],X={};var G=\"\",Y=0;var J=false,Z=false;var K=0;jt.lastIndex=0;n=Pr(Lr(n,\"<!--\",\"-->\"));while(v=jt.exec(n))switch(v[3]=v[3].replace(/_[\\s\\S]*$/,\"\")){case\"table\":;case\"工作表\":if(v[1]===\"/\"){if(D.e.c>=D.s.c&&D.e.r>=D.s.r)m[\"!ref\"]=Ka(D);else m[\"!ref\"]=\"A1:A1\";if(a.sheetRows>0&&a.sheetRows<=D.e.r){m[\"!fullref\"]=m[\"!ref\"];D.e.r=a.sheetRows-1;m[\"!ref\"]=Ka(D)}if(I.length)m[\"!merges\"]=I;if(U.length)m[\"!rows\"]=U;u.name=u[\"名称\"]||u.name;if(typeof JSON!==\"undefined\")JSON.stringify(u);p.push(u.name);d[u.name]=m;Z=false}else if(v[0].charAt(v[0].length-2)!==\"/\"){u=ft(v[0],false);E=F=-1;D.s.r=D.s.c=1e7;D.e.r=D.e.c=0;m={};if(a.dense)m[\"!data\"]=[];I=[];U=[];Z=true}break;case\"table-row-group\":if(v[1]===\"/\")--O;else++O;break;case\"table-row\":;case\"行\":if(v[1]===\"/\"){E+=B;B=1;break}h=ft(v[0],false);if(h[\"行号\"])E=h[\"行号\"]-1;else if(E==-1)E=0;B=+h[\"number-rows-repeated\"]||1;if(B<10)for(K=0;K<B;++K)if(O>0)U[E+K]={level:O};F=-1;break;case\"covered-table-cell\":if(v[1]!==\"/\"){++F;w=ft(v[0],false);z=parseInt(w[\"number-columns-repeated\"]||\"1\",10)||1;if(a.sheetStubs){while(z-- >0){if(a.dense){if(!m[\"!data\"][E])m[\"!data\"][E]=[];m[\"!data\"][E][F]={t:\"z\"}}else m[Ja({r:E,c:F})]={t:\"z\"};++F}--F}else F+=z-1}y=\"\";A=[];break;case\"table-cell\":;case\"数据\":if(v[0].charAt(v[0].length-2)===\"/\"){++F;w=ft(v[0],false);z=parseInt(w[\"number-columns-repeated\"]||\"1\",10)||1;g={t:\"z\",v:null};if(w.formula&&a.cellFormula!=false)g.f=Bs(mt(w.formula));if(w[\"style-name\"]&&M[w[\"style-name\"]])g.z=M[w[\"style-name\"]];if((w[\"数据类型\"]||w[\"value-type\"])==\"string\"){g.t=\"s\";g.v=mt(w[\"string-value\"]||\"\");if(a.dense){if(!m[\"!data\"][E])m[\"!data\"][E]=[];m[\"!data\"][E][F]=g}else{m[Ha(F)+za(E)]=g}}F+=z-1}else if(v[1]!==\"/\"){++F;y=S=\"\";x=_=0;A=[];T=[];z=1;\nvar q=B?E+B-1:E;if(F>D.e.c)D.e.c=F;if(F<D.s.c)D.s.c=F;if(E<D.s.r)D.s.r=E;if(q>D.e.r)D.e.r=q;w=ft(v[0],false);k=ut(v[0],true);V=[];X={};g={t:w[\"数据类型\"]||w[\"value-type\"],v:null};if(w[\"style-name\"]&&M[w[\"style-name\"]])g.z=M[w[\"style-name\"]];if(a.cellFormula){if(w.formula)w.formula=mt(w.formula);if(w[\"number-matrix-columns-spanned\"]&&w[\"number-matrix-rows-spanned\"]){R=parseInt(w[\"number-matrix-rows-spanned\"],10)||0;L=parseInt(w[\"number-matrix-columns-spanned\"],10)||0;P={s:{r:E,c:F},e:{r:E+R-1,c:F+L-1}};g.F=Ka(P);$.push([P,g.F])}if(w.formula)g.f=Bs(w.formula);else for(K=0;K<$.length;++K)if(E>=$[K][0].s.r&&E<=$[K][0].e.r)if(F>=$[K][0].s.c&&F<=$[K][0].e.c)g.F=$[K][1]}if(w[\"number-columns-spanned\"]||w[\"number-rows-spanned\"]){R=parseInt(w[\"number-rows-spanned\"]||\"1\",10)||1;L=parseInt(w[\"number-columns-spanned\"]||\"1\",10)||1;if(R*L>1){P={s:{r:E,c:F},e:{r:E+R-1,c:F+L-1}};I.push(P)}}if(w[\"number-columns-repeated\"])z=parseInt(w[\"number-columns-repeated\"],10);switch(g.t){case\"boolean\":g.t=\"b\";g.v=_t(w[\"boolean-value\"])||+w[\"boolean-value\"]>=1;break;case\"float\":g.t=\"n\";g.v=parseFloat(w.value);if(a.cellDates&&g.z&&Re(g.z)){g.v=pr(g.v+(W.WBProps.date1904?1462:0));g.t=typeof g.v==\"number\"?\"n\":\"d\"}break;case\"percentage\":g.t=\"n\";g.v=parseFloat(w.value);break;case\"currency\":g.t=\"n\";g.v=parseFloat(w.value);break;case\"date\":g.t=\"d\";g.v=wr(w[\"date-value\"],W.WBProps.date1904);if(!a.cellDates){g.t=\"n\";g.v=dr(g.v,W.WBProps.date1904)}if(!g.z)g.z=\"m/d/yy\";break;case\"time\":g.t=\"n\";g.v=mr(w[\"time-value\"])/86400;if(a.cellDates){g.v=pr(g.v);g.t=typeof g.v==\"number\"?\"n\":\"d\"}if(!g.z)g.z=\"HH:MM:SS\";break;case\"number\":g.t=\"n\";g.v=parseFloat(w[\"数据数值\"]);break;default:if(g.t===\"string\"||g.t===\"text\"||!g.t){g.t=\"s\";if(w[\"string-value\"]!=null){y=mt(w[\"string-value\"]);A=[]}}else throw new Error(\"Unsupported value type \"+g.t);}}else{J=false;if(k[\"calcext:value-type\"]==\"error\"&&Fn[y]!=null){g.t=\"e\";g.w=y;g.v=Fn[y]}if(g.t===\"s\"){g.v=y||\"\";if(A.length)g.R=A;J=x==0}if(j.Target)g.l=j;if(V.length>0){g.c=V;V=[]}if(y&&a.cellText!==false)g.w=y;if(J){g.t=\"z\";delete g.v}if(!J||a.sheetStubs){if(!(a.sheetRows&&a.sheetRows<=E)){for(var Q=0;Q<B;++Q){z=parseInt(w[\"number-columns-repeated\"]||\"1\",10);if(a.dense){if(!m[\"!data\"][E+Q])m[\"!data\"][E+Q]=[];m[\"!data\"][E+Q][F]=Q==0?g:yr(g);while(--z>0)m[\"!data\"][E+Q][F+z]=yr(g)}else{m[Ja({r:E+Q,c:F})]=g;while(--z>0)m[Ja({r:E+Q,c:F+z})]=yr(g)}if(D.e.c<=F)D.e.c=F}}}z=parseInt(w[\"number-columns-repeated\"]||\"1\",10);F+=z-1;z=0;g={};y=\"\";A=[]}j={};break;case\"document\":;case\"document-content\":;case\"电子表格文档\":;case\"spreadsheet\":;case\"主体\":;case\"scripts\":;case\"styles\":;case\"font-face-decls\":;case\"master-styles\":if(v[1]===\"/\"){if((s=i.pop())[0]!==v[3])throw\"Bad state: \"+s}else if(v[0].charAt(v[0].length-2)!==\"/\")i.push([v[3],true]);break;case\"annotation\":if(v[1]===\"/\"){if((s=i.pop())[0]!==v[3])throw\"Bad state: \"+s;X.t=y;if(A.length)X.R=A;X.a=G;V.push(X);y=S;x=_;A=T}else if(v[0].charAt(v[0].length-2)!==\"/\"){i.push([v[3],false]);var ee=ft(v[0],true);if(!(ee[\"display\"]&&_t(ee[\"display\"])))V.hidden=true;S=y;_=x;T=A;y=\"\";x=0;A=[]}G=\"\";Y=0;break;case\"creator\":if(v[1]===\"/\"){G=n.slice(Y,v.index)}else Y=v.index+v[0].length;break;case\"meta\":;case\"元数据\":;case\"settings\":;case\"config-item-set\":;case\"config-item-map-indexed\":;case\"config-item-map-entry\":;case\"config-item-map-named\":;case\"shapes\":;case\"frame\":;case\"text-box\":;case\"image\":;case\"data-pilot-tables\":;case\"list-style\":;case\"form\":;case\"dde-links\":;case\"event-listeners\":;case\"chart\":if(v[1]===\"/\"){if((s=i.pop())[0]!==v[3])throw\"Bad state: \"+s}else if(v[0].charAt(v[0].length-2)!==\"/\")i.push([v[3],false]);y=\"\";x=0;A=[];break;case\"scientific-number\":;case\"currency-symbol\":;case\"fill-character\":break;case\"text-style\":;case\"boolean-style\":;case\"number-style\":;case\"currency-style\":;case\"percentage-style\":;case\"date-style\":;case\"time-style\":if(v[1]===\"/\"){var re=jt.lastIndex;go(n.slice(o,jt.lastIndex),r,N);jt.lastIndex=re}else if(v[0].charAt(v[0].length-2)!==\"/\"){o=jt.lastIndex-v[0].length}break;case\"script\":break;case\"libraries\":break;case\"automatic-styles\":break;case\"default-style\":;case\"page-layout\":break;case\"style\":{var te=ft(v[0],false);if(te[\"family\"]==\"table-cell\"&&N[te[\"data-style-name\"]])M[te[\"name\"]]=N[te[\"data-style-name\"]]}break;case\"map\":break;case\"font-face\":break;case\"paragraph-properties\":break;case\"table-properties\":break;case\"table-column-properties\":break;case\"table-row-properties\":break;case\"table-cell-properties\":break;case\"number\":break;case\"fraction\":break;case\"day\":;case\"month\":;case\"year\":;case\"era\":;case\"day-of-week\":;case\"week-of-year\":;case\"quarter\":;case\"hours\":;case\"minutes\":;case\"seconds\":;case\"am-pm\":break;case\"boolean\":break;case\"text\":if(v[0].slice(-2)===\"/>\")break;else if(v[1]===\"/\")switch(i[i.length-1][0]){case\"number-style\":;case\"date-style\":;case\"time-style\":c+=n.slice(f,v.index);break;}else f=v.index+v[0].length;break;case\"named-range\":l=ft(v[0],false);H=$s(l[\"cell-range-address\"]);var ae={Name:l.name,Ref:H[0]+\"!\"+H[1]};if(Z)ae.Sheet=p.length;W.Names.push(ae);break;case\"text-content\":break;case\"text-properties\":break;case\"embedded-text\":break;case\"body\":;case\"电子表格\":break;case\"forms\":break;case\"table-column\":break;case\"table-header-rows\":break;case\"table-rows\":break;case\"table-column-group\":break;case\"table-header-columns\":break;case\"table-columns\":break;case\"null-date\":l=ft(v[0],false);switch(l[\"date-value\"]){case\"1904-01-01\":W.WBProps.date1904=true;break;}break;case\"graphic-properties\":break;case\"calculation-settings\":break;case\"named-expressions\":break;case\"label-range\":break;case\"label-ranges\":break;case\"named-expression\":break;case\"sort\":break;case\"sort-by\":break;case\"sort-groups\":break;case\"tab\":break;case\"line-break\":break;case\"span\":break;case\"p\":;case\"文本串\":if([\"master-styles\"].indexOf(i[i.length-1][0])>-1)break;if(v[1]===\"/\"&&(!w||!w[\"string-value\"])){var ne=vo(n.slice(x,v.index),C);y=(y.length>0?y+\"\\n\":\"\")+ne[0]}else if(v[0].slice(-2)==\"/>\"){y+=\"\\n\"}else{C=ft(v[0],false);x=v.index+v[0].length}break;case\"s\":break;case\"database-range\":if(v[1]===\"/\")break;try{H=$s(ft(v[0])[\"target-range-address\"]);d[H[0]][\"!autofilter\"]={ref:H[1]}}catch(ie){}break;case\"date\":break;case\"object\":break;case\"title\":;case\"标题\":break;case\"desc\":break;case\"binary-data\":break;case\"table-source\":break;case\"scenario\":break;case\"iteration\":break;case\"content-validations\":break;case\"content-validation\":break;case\"help-message\":break;case\"error-message\":break;case\"database-ranges\":break;case\"filter\":break;case\"filter-and\":break;case\"filter-or\":break;case\"filter-condition\":break;case\"filter-set-item\":break;case\"list-level-style-bullet\":break;case\"list-level-style-number\":break;case\"list-level-properties\":break;case\"sender-firstname\":;case\"sender-lastname\":;case\"sender-initials\":;case\"sender-title\":;case\"sender-position\":;case\"sender-email\":;case\"sender-phone-private\":;case\"sender-fax\":;case\"sender-company\":;case\"sender-phone-work\":;case\"sender-street\":;case\"sender-city\":;case\"sender-postal-code\":;case\"sender-country\":;case\"sender-state-or-province\":;case\"author-name\":;case\"author-initials\":;case\"chapter\":;case\"file-name\":;case\"template-name\":;case\"sheet-name\":break;case\"event-listener\":break;case\"initial-creator\":;case\"creation-date\":;case\"print-date\":;case\"generator\":;case\"document-statistic\":;case\"user-defined\":;case\"editing-duration\":;case\"editing-cycles\":break;case\"config-item\":break;case\"page-number\":break;case\"page-count\":break;case\"time\":break;case\"cell-range-source\":break;case\"detective\":break;case\"operation\":break;case\"highlighted-range\":break;case\"data-pilot-table\":;case\"source-cell-range\":;case\"source-service\":;case\"data-pilot-field\":;case\"data-pilot-level\":;case\"data-pilot-subtotals\":;case\"data-pilot-subtotal\":;case\"data-pilot-members\":;case\"data-pilot-member\":;case\"data-pilot-display-info\":;case\"data-pilot-sort-info\":;case\"data-pilot-layout-info\":;case\"data-pilot-field-reference\":;case\"data-pilot-groups\":;case\"data-pilot-group\":;case\"data-pilot-group-member\":break;case\"rect\":break;case\"dde-connection-decls\":;case\"dde-connection-decl\":;case\"dde-link\":;case\"dde-source\":break;case\"properties\":break;case\"property\":break;case\"a\":if(v[1]!==\"/\"){j=ft(v[0],false);if(!j.href)break;j.Target=mt(j.href);delete j.href;if(j.Target.charAt(0)==\"#\"&&j.Target.indexOf(\".\")>-1){H=$s(j.Target.slice(1));j.Target=\"#\"+H[0]+\"!\"+H[1]}else if(j.Target.match(/^\\.\\.[\\\\\\/]/))j.Target=j.Target.slice(3)}break;case\"table-protection\":break;case\"data-pilot-grand-total\":break;case\"office-document-common-attrs\":break;default:switch(v[2]){case\"dc:\":;case\"calcext:\":;case\"loext:\":;case\"ooo:\":;case\"chartooo:\":;case\"draw:\":;case\"style:\":;case\"chart:\":;case\"form:\":;case\"uof:\":;case\"表:\":;case\"字:\":break;default:if(a.WTF)throw new Error(v);};}var se={Sheets:d,SheetNames:p,Workbook:W};if(a.bookSheets)delete se.Sheets;return se}function wo(e,r){r=r||{};if(Gr(e,\"META-INF/manifest.xml\"))Wn(Jr(e,\"META-INF/manifest.xml\"),r);var t=Zr(e,\"styles.xml\");var a=t&&go(Dt(t),r);var n=Zr(e,\"content.xml\");if(!n)throw new Error(\"Missing content.xml in ODS / UOF file\");var i=bo(Dt(n),r,a);if(Gr(e,\"meta.xml\"))i.Props=Jn(Jr(e,\"meta.xml\"));i.bookType=\"ods\";return i}function ko(e,r){var t=bo(e,r);t.bookType=\"fods\";return t}var yo=function(){var e=[\"<office:master-styles>\",'<style:master-page style:name=\"mp1\" style:page-layout-name=\"mp1\">',\"<style:header/>\",'<style:header-left style:display=\"false\"/>',\"<style:footer/>\",'<style:footer-left style:display=\"false\"/>',\"</style:master-page>\",\"</office:master-styles>\"].join(\"\");var r=\"<office:document-styles \"+Ut({\"xmlns:office\":\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\",\"xmlns:table\":\"urn:oasis:names:tc:opendocument:xmlns:table:1.0\",\"xmlns:style\":\"urn:oasis:names:tc:opendocument:xmlns:style:1.0\",\"xmlns:text\":\"urn:oasis:names:tc:opendocument:xmlns:text:1.0\",\"xmlns:draw\":\"urn:oasis:names:tc:opendocument:xmlns:drawing:1.0\",\"xmlns:fo\":\"urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0\",\"xmlns:xlink\":\"http://www.w3.org/1999/xlink\",\"xmlns:dc\":\"http://purl.org/dc/elements/1.1/\",\"xmlns:number\":\"urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0\",\"xmlns:svg\":\"urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0\",\"xmlns:of\":\"urn:oasis:names:tc:opendocument:xmlns:of:1.2\",\"office:version\":\"1.2\"})+\">\"+e+\"</office:document-styles>\";return function t(){return at+r}}();function xo(e,r){var t=\"number\",a=\"\",n={\"style:name\":r},i=\"\",s=0;e=e.replace(/\"[$]\"/g,\"$\");e:{if(e.indexOf(\";\")>-1){console.error(\"Unsupported ODS Style Map exported.  Using first branch of \"+e);e=e.slice(0,e.indexOf(\";\"))}if(e==\"@\"){t=\"text\";a=\"<number:text-content/>\";break e}if(e.indexOf(/\\$/)>-1){t=\"currency\"}if(e[s]=='\"'){i=\"\";while(e[++s]!='\"'||e[++s]=='\"')i+=e[s];--s;if(e[s+1]==\"*\"){s++;a+=\"<number:fill-character>\"+bt(i.replace(/\"\"/g,'\"'))+\"</number:fill-character>\"}else{a+=\"<number:text>\"+bt(i.replace(/\"\"/g,'\"'))+\"</number:text>\"}e=e.slice(s+1);s=0}var l=e.match(/# (\\?+)\\/(\\?+)/);if(l){a+=Bt(\"number:fraction\",null,{\"number:min-integer-digits\":0,\"number:min-numerator-digits\":l[1].length,\"number:max-denominator-value\":Math.max(+l[1].replace(/./g,\"9\"),+l[2].replace(/./g,\"9\"))});break e}if(l=e.match(/# (\\?+)\\/(\\d+)/)){a+=Bt(\"number:fraction\",null,{\"number:min-integer-digits\":0,\"number:min-numerator-digits\":l[1].length,\"number:denominator-value\":+l[2]});break e}if(l=e.match(/\\b(\\d+)(|\\.\\d+)%/)){t=\"percentage\";a+=Bt(\"number:number\",null,{\"number:decimal-places\":l[2]&&l.length-1||0,\"number:min-decimal-places\":l[2]&&l.length-1||0,\"number:min-integer-digits\":l[1].length})+\"<number:text>%</number:text>\";break e}var o=false;if([\"y\",\"m\",\"d\"].indexOf(e[0])>-1){t=\"date\";r:for(;s<e.length;++s)switch(i=e[s].toLowerCase()){case\"h\":;case\"s\":o=true;--s;break r;case\"m\":t:for(var c=s+1;c<e.length;++c)switch(e[c]){case\"y\":;case\"d\":break t;case\"h\":;case\"s\":o=true;--s;break r;};case\"y\":;case\"d\":while((e[++s]||\"\").toLowerCase()==i[0])i+=i[0];--s;switch(i){case\"y\":;case\"yy\":a+=\"<number:year/>\";break;case\"yyy\":;case\"yyyy\":a+='<number:year number:style=\"long\"/>';break;case\"mmmmm\":console.error(\"ODS has no equivalent of format |mmmmm|\");case\"m\":;case\"mm\":;case\"mmm\":;case\"mmmm\":a+='<number:month number:style=\"'+(i.length%2?\"short\":\"long\")+'\" number:textual=\"'+(i.length>=3?\"true\":\"false\")+'\"/>';break;case\"d\":;case\"dd\":a+='<number:day number:style=\"'+(i.length%2?\"short\":\"long\")+'\"/>';break;case\"ddd\":;case\"dddd\":a+='<number:day-of-week number:style=\"'+(i.length%2?\"short\":\"long\")+'\"/>';break;}break;case'\"':while(e[++s]!='\"'||e[++s]=='\"')i+=e[s];--s;a+=\"<number:text>\"+bt(i.slice(1).replace(/\"\"/g,'\"'))+\"</number:text>\";break;case\"\\\\\":i=e[++s];a+=\"<number:text>\"+bt(i)+\"</number:text>\";break;case\"/\":;case\":\":a+=\"<number:text>\"+bt(i)+\"</number:text>\";break;default:console.error(\"unrecognized character \"+i+\" in ODF format \"+e);}if(!o)break e;e=e.slice(s+1);s=0}if(e.match(/^\\[?[hms]/)){if(t==\"number\")t=\"time\";if(e.match(/\\[/)){e=e.replace(/[\\[\\]]/g,\"\");n[\"number:truncate-on-overflow\"]=\"false\"}for(;s<e.length;++s)switch(i=e[s].toLowerCase()){case\"h\":;case\"m\":;case\"s\":while((e[++s]||\"\").toLowerCase()==i[0])i+=i[0];--s;switch(i){case\"h\":;case\"hh\":a+='<number:hours number:style=\"'+(i.length%2?\"short\":\"long\")+'\"/>';break;case\"m\":;case\"mm\":a+='<number:minutes number:style=\"'+(i.length%2?\"short\":\"long\")+'\"/>';break;case\"s\":;case\"ss\":if(e[s+1]==\".\")do{i+=e[s+1];++s}while(e[s+1]==\"0\");a+='<number:seconds number:style=\"'+(i.match(\"ss\")?\"long\":\"short\")+'\"'+(i.match(/\\./)?' number:decimal-places=\"'+(i.match(/0+/)||[\"\"])[0].length+'\"':\"\")+\"/>\";break;}break;case'\"':while(e[++s]!='\"'||e[++s]=='\"')i+=e[s];--s;a+=\"<number:text>\"+bt(i.slice(1).replace(/\"\"/g,'\"'))+\"</number:text>\";break;case\"/\":;case\":\":a+=\"<number:text>\"+bt(i)+\"</number:text>\";break;case\"a\":if(e.slice(s,s+3).toLowerCase()==\"a/p\"){a+=\"<number:am-pm/>\";s+=2;break}if(e.slice(s,s+5).toLowerCase()==\"am/pm\"){a+=\"<number:am-pm/>\";s+=4;break};default:console.error(\"unrecognized character \"+i+\" in ODF format \"+e);}break e}if(e.indexOf(/\\$/)>-1){t=\"currency\"}if(e[0]==\"$\"){a+='<number:currency-symbol number:language=\"en\" number:country=\"US\">$</number:currency-symbol>';e=e.slice(1);s=0}s=0;if(e[s]=='\"'){while(e[++s]!='\"'||e[++s]=='\"')i+=e[s];--s;if(e[s+1]==\"*\"){s++;a+=\"<number:fill-character>\"+bt(i.replace(/\"\"/g,'\"'))+\"</number:fill-character>\"}else{a+=\"<number:text>\"+bt(i.replace(/\"\"/g,'\"'))+\"</number:text>\"}e=e.slice(s+1);s=0}var f=e.match(/([#0][0#,]*)(\\.[0#]*|)(E[+]?0*|)/i);if(!f||!f[0])console.error(\"Could not find numeric part of \"+e);else{var u=f[1].replace(/,/g,\"\");a+=\"<number:\"+(f[3]?\"scientific-\":\"\")+\"number\"+' number:min-integer-digits=\"'+(u.indexOf(\"0\")==-1?\"0\":u.length-u.indexOf(\"0\"))+'\"'+(f[0].indexOf(\",\")>-1?' number:grouping=\"true\"':\"\")+(f[2]&&' number:decimal-places=\"'+(f[2].length-1)+'\"'||' number:decimal-places=\"0\"')+(f[3]&&f[3].indexOf(\"+\")>-1?' number:forced-exponent-sign=\"true\"':\"\")+(f[3]?' number:min-exponent-digits=\"'+f[3].match(/0+/)[0].length+'\"':\"\")+\">\"+\"</number:\"+(f[3]?\"scientific-\":\"\")+\"number>\";s=f.index+f[0].length}if(e[s]=='\"'){i=\"\";while(e[++s]!='\"'||e[++s]=='\"')i+=e[s];--s;a+=\"<number:text>\"+bt(i.replace(/\"\"/g,'\"'))+\"</number:text>\"}}if(!a){console.error(\"Could not generate ODS number format for |\"+e+\"|\");return\"\"}return Bt(\"number:\"+t+\"-style\",a,n)}function Co(e,r,t){var a=[];for(var n=0;n<e.length;++n){var i=e[n];if(!i)continue;if(i.Sheet==(t==-1?null:t))a.push(i)}if(!a.length)return\"\";return\"      <table:named-expressions>\\n\"+a.map(function(e){var r=(t==-1?\"$\":\"\")+Ws(e.Ref);return\"        \"+Bt(\"table:named-range\",null,{\"table:name\":e.Name,\"table:cell-range-address\":r,\"table:base-cell-address\":r.replace(/[\\.][^\\.]*$/,\".$A$1\")})}).join(\"\\n\")+\"\\n      </table:named-expressions>\\n\"}var So=function(){var e=function(e,r){return bt(e).replace(/  +/g,function(e){return'<text:s text:c=\"'+e.length+'\"/>'}).replace(/\\t/g,\"<text:tab/>\").replace(/\\n/g,r?\"<text:line-break/>\":\"</text:p><text:p>\").replace(/^ /,\"<text:s/>\").replace(/ $/,\"<text:s/>\")};var r=\"          <table:table-cell />\\n\";var t=function(t,a,n,i,s,l){var o=[];o.push('      <table:table table:name=\"'+bt(a.SheetNames[n])+'\" table:style-name=\"ta1\">\\n');var c=0,f=0,u=Za(t[\"!ref\"]||\"A1\");var h=t[\"!merges\"]||[],d=0;var p=t[\"!data\"]!=null;if(t[\"!cols\"]){for(f=0;f<=u.e.c;++f)o.push(\"        <table:table-column\"+(t[\"!cols\"][f]?' table:style-name=\"co'+t[\"!cols\"][f].ods+'\"':\"\")+\"></table:table-column>\\n\")}var m=\"\",v=t[\"!rows\"]||[];for(c=0;c<u.s.r;++c){m=v[c]?' table:style-name=\"ro'+v[c].ods+'\"':\"\";o.push(\"        <table:table-row\"+m+\"></table:table-row>\\n\")}for(;c<=u.e.r;++c){m=v[c]?' table:style-name=\"ro'+v[c].ods+'\"':\"\";o.push(\"        <table:table-row\"+m+\">\\n\");for(f=0;f<u.s.c;++f)o.push(r);for(;f<=u.e.c;++f){var g=false,b={},w=\"\";for(d=0;d!=h.length;++d){if(h[d].s.c>f)continue;if(h[d].s.r>c)continue;if(h[d].e.c<f)continue;if(h[d].e.r<c)continue;if(h[d].s.c!=f||h[d].s.r!=c)g=true;b[\"table:number-columns-spanned\"]=h[d].e.c-h[d].s.c+1;b[\"table:number-rows-spanned\"]=h[d].e.r-h[d].s.r+1;break}if(g){o.push(\"          <table:covered-table-cell/>\\n\");continue}var k=Ja({r:c,c:f}),y=p?(t[\"!data\"][c]||[])[f]:t[k];if(y&&y.f){b[\"table:formula\"]=bt(zs(y.f));if(y.F){if(y.F.slice(0,k.length)==k){var x=Za(y.F);b[\"table:number-matrix-columns-spanned\"]=x.e.c-x.s.c+1;b[\"table:number-matrix-rows-spanned\"]=x.e.r-x.s.r+1}}}if(!y){o.push(r);continue}switch(y.t){case\"b\":w=y.v?\"TRUE\":\"FALSE\";b[\"office:value-type\"]=\"boolean\";b[\"office:boolean-value\"]=y.v?\"true\":\"false\";break;case\"n\":if(!isFinite(y.v)){if(isNaN(y.v)){w=\"#NUM!\";b[\"table:formula\"]=\"of:=#NUM!\"}else{w=\"#DIV/0!\";b[\"table:formula\"]=\"of:=\"+(y.v<0?\"-\":\"\")+\"1/0\"}b[\"office:string-value\"]=\"\";b[\"office:value-type\"]=\"string\";b[\"calcext:value-type\"]=\"error\"}else{w=y.w||String(y.v||0);b[\"office:value-type\"]=\"float\";b[\"office:value\"]=y.v||0}break;case\"s\":;case\"str\":w=y.v==null?\"\":y.v;b[\"office:value-type\"]=\"string\";break;case\"d\":w=y.w||wr(y.v,l).toISOString();b[\"office:value-type\"]=\"date\";b[\"office:date-value\"]=wr(y.v,l).toISOString();b[\"table:style-name\"]=\"ce1\";break;default:o.push(r);continue;}var C=e(w);if(y.l&&y.l.Target){var S=y.l.Target;S=S.charAt(0)==\"#\"?\"#\"+Ws(S.slice(1)):S;if(S.charAt(0)!=\"#\"&&!S.match(/^\\w+:/))S=\"../\"+S;C=Bt(\"text:a\",C,{\"xlink:href\":S.replace(/&/g,\"&amp;\")})}if(s[y.z])b[\"table:style-name\"]=\"ce\"+s[y.z].slice(1);var _=Bt(\"text:p\",C,{});if(y.c){var A=\"\",T=\"\",E={};for(var F=0;F<y.c.length;++F){if(!A&&y.c[F].a)A=y.c[F].a;T+=\"<text:p>\"+e(y.c[F].t)+\"</text:p>\"}if(!y.c.hidden)E[\"office:display\"]=true;_=Bt(\"office:annotation\",T,E)+_}o.push(\"          \"+Bt(\"table:table-cell\",_,b)+\"\\n\")}o.push(\"        </table:table-row>\\n\")}if((a.Workbook||{}).Names)o.push(Co(a.Workbook.Names,a.SheetNames,n));o.push(\"      </table:table>\\n\");return o.join(\"\")};var a=function(e,r){e.push(\" <office:automatic-styles>\\n\");var t=0;r.SheetNames.map(function(e){return r.Sheets[e]}).forEach(function(r){if(!r)return;if(r[\"!cols\"]){for(var a=0;a<r[\"!cols\"].length;++a)if(r[\"!cols\"][a]){var n=r[\"!cols\"][a];if(n.width==null&&n.wpx==null&&n.wch==null)continue;Ui(n);n.ods=t;var i=r[\"!cols\"][a].wpx+\"px\";e.push('  <style:style style:name=\"co'+t+'\" style:family=\"table-column\">\\n');e.push('   <style:table-column-properties fo:break-before=\"auto\" style:column-width=\"'+i+'\"/>\\n');e.push(\"  </style:style>\\n\");++t}}});var a=0;r.SheetNames.map(function(e){return r.Sheets[e]}).forEach(function(r){if(!r)return;if(r[\"!rows\"]){for(var t=0;t<r[\"!rows\"].length;++t)if(r[\"!rows\"][t]){r[\"!rows\"][t].ods=a;var n=r[\"!rows\"][t].hpx+\"px\";e.push('  <style:style style:name=\"ro'+a+'\" style:family=\"table-row\">\\n');e.push('   <style:table-row-properties fo:break-before=\"auto\" style:row-height=\"'+n+'\"/>\\n');e.push(\"  </style:style>\\n\");++a}}});e.push('  <style:style style:name=\"ta1\" style:family=\"table\" style:master-page-name=\"mp1\">\\n');e.push('   <style:table-properties table:display=\"true\" style:writing-mode=\"lr-tb\"/>\\n');e.push(\"  </style:style>\\n\");e.push('  <number:date-style style:name=\"N37\" number:automatic-order=\"true\">\\n');e.push('   <number:month number:style=\"long\"/>\\n');e.push(\"   <number:text>/</number:text>\\n\");e.push('   <number:day number:style=\"long\"/>\\n');e.push(\"   <number:text>/</number:text>\\n\");e.push(\"   <number:year/>\\n\");e.push(\"  </number:date-style>\\n\");var n={};var i=69;r.SheetNames.map(function(e){return r.Sheets[e]}).forEach(function(r){if(!r)return;var t=r[\"!data\"]!=null;if(!r[\"!ref\"])return;var a=Za(r[\"!ref\"]);for(var s=0;s<=a.e.r;++s)for(var l=0;l<=a.e.c;++l){var o=t?(r[\"!data\"][s]||[])[l]:r[Ja({r:s,c:l})];if(!o||!o.z||o.z.toLowerCase()==\"general\")continue;if(!n[o.z]){var c=xo(o.z,\"N\"+i);if(c){n[o.z]=\"N\"+i;++i;e.push(c+\"\\n\")}}}});e.push('  <style:style style:name=\"ce1\" style:family=\"table-cell\" style:parent-style-name=\"Default\" style:data-style-name=\"N37\"/>\\n');ir(n).forEach(function(r){e.push('<style:style style:name=\"ce'+n[r].slice(1)+'\" style:family=\"table-cell\" style:parent-style-name=\"Default\" style:data-style-name=\"'+n[r]+'\"/>\\n')});e.push(\" </office:automatic-styles>\\n\");return n};return function n(e,r){var n=[at];var i=Ut({\"xmlns:office\":\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\",\"xmlns:table\":\"urn:oasis:names:tc:opendocument:xmlns:table:1.0\",\"xmlns:style\":\"urn:oasis:names:tc:opendocument:xmlns:style:1.0\",\"xmlns:text\":\"urn:oasis:names:tc:opendocument:xmlns:text:1.0\",\"xmlns:draw\":\"urn:oasis:names:tc:opendocument:xmlns:drawing:1.0\",\"xmlns:fo\":\"urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0\",\"xmlns:xlink\":\"http://www.w3.org/1999/xlink\",\"xmlns:dc\":\"http://purl.org/dc/elements/1.1/\",\"xmlns:meta\":\"urn:oasis:names:tc:opendocument:xmlns:meta:1.0\",\"xmlns:number\":\"urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0\",\"xmlns:presentation\":\"urn:oasis:names:tc:opendocument:xmlns:presentation:1.0\",\"xmlns:svg\":\"urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0\",\"xmlns:chart\":\"urn:oasis:names:tc:opendocument:xmlns:chart:1.0\",\"xmlns:dr3d\":\"urn:oasis:names:tc:opendocument:xmlns:dr3d:1.0\",\"xmlns:math\":\"http://www.w3.org/1998/Math/MathML\",\"xmlns:form\":\"urn:oasis:names:tc:opendocument:xmlns:form:1.0\",\"xmlns:script\":\"urn:oasis:names:tc:opendocument:xmlns:script:1.0\",\"xmlns:ooo\":\"http://openoffice.org/2004/office\",\"xmlns:ooow\":\"http://openoffice.org/2004/writer\",\"xmlns:oooc\":\"http://openoffice.org/2004/calc\",\"xmlns:dom\":\"http://www.w3.org/2001/xml-events\",\"xmlns:xforms\":\"http://www.w3.org/2002/xforms\",\"xmlns:xsd\":\"http://www.w3.org/2001/XMLSchema\",\"xmlns:xsi\":\"http://www.w3.org/2001/XMLSchema-instance\",\"xmlns:sheet\":\"urn:oasis:names:tc:opendocument:sh33tjs:1.0\",\"xmlns:rpt\":\"http://openoffice.org/2005/report\",\"xmlns:of\":\"urn:oasis:names:tc:opendocument:xmlns:of:1.2\",\"xmlns:xhtml\":\"http://www.w3.org/1999/xhtml\",\"xmlns:grddl\":\"http://www.w3.org/2003/g/data-view#\",\"xmlns:tableooo\":\"http://openoffice.org/2009/table\",\"xmlns:drawooo\":\"http://openoffice.org/2010/draw\",\"xmlns:calcext\":\"urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0\",\"xmlns:loext\":\"urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0\",\"xmlns:field\":\"urn:openoffice:names:experimental:ooo-ms-interop:xmlns:field:1.0\",\"xmlns:formx\":\"urn:openoffice:names:experimental:ooxml-odf-interop:xmlns:form:1.0\",\"xmlns:css3t\":\"http://www.w3.org/TR/css3-text/\",\"office:version\":\"1.2\"});var s=Ut({\"xmlns:config\":\"urn:oasis:names:tc:opendocument:xmlns:config:1.0\",\"office:mimetype\":\"application/vnd.oasis.opendocument.spreadsheet\"});if(r.bookType==\"fods\"){n.push(\"<office:document\"+i+s+\">\\n\");n.push(Gn().replace(/<office:document-meta[^<>]*?>/,\"\").replace(/<\\/office:document-meta>/,\"\")+\"\\n\")}else n.push(\"<office:document-content\"+i+\">\\n\");var l=a(n,e);n.push(\"  <office:body>\\n\");n.push(\"    <office:spreadsheet>\\n\");if(((e.Workbook||{}).WBProps||{}).date1904)n.push('      <table:calculation-settings table:case-sensitive=\"false\" table:search-criteria-must-apply-to-whole-cell=\"true\" table:use-wildcards=\"true\" table:use-regular-expressions=\"false\" table:automatic-find-labels=\"false\">\\n        <table:null-date table:date-value=\"1904-01-01\"/>\\n      </table:calculation-settings>\\n');for(var o=0;o!=e.SheetNames.length;++o)n.push(t(e.Sheets[e.SheetNames[o]],e,o,r,l,((e.Workbook||{}).WBProps||{}).date1904));if((e.Workbook||{}).Names)n.push(Co(e.Workbook.Names,e.SheetNames,-1));n.push(\"    </office:spreadsheet>\\n\");n.push(\"  </office:body>\\n\");if(r.bookType==\"fods\")n.push(\"</office:document>\");else n.push(\"</office:document-content>\");return n.join(\"\")}}();function _o(e,r){if(r.bookType==\"fods\")return So(e,r);var t=et();var a=\"\";var n=[];var i=[];a=\"mimetype\";Qr(t,a,\"application/vnd.oasis.opendocument.spreadsheet\");a=\"content.xml\";Qr(t,a,So(e,r));n.push([a,\"text/xml\"]);i.push([a,\"ContentFile\"]);a=\"styles.xml\";Qr(t,a,yo(e,r));n.push([a,\"text/xml\"]);i.push([a,\"StylesFile\"]);a=\"meta.xml\";Qr(t,a,at+Gn());n.push([a,\"text/xml\"]);i.push([a,\"MetadataFile\"]);a=\"manifest.rdf\";Qr(t,a,Xn(i));n.push([a,\"application/rdf+xml\"]);a=\"META-INF/manifest.xml\";Qr(t,a,jn(n));return t}function Ao(e){return function r(t){for(var a=0;a!=e.length;++a){var n=e[a];if(t[n[0]]===undefined)t[n[0]]=n[1];if(n[2]===\"n\")t[n[0]]=Number(t[n[0]])}}}function To(e){Ao([[\"cellNF\",false],[\"cellHTML\",true],[\"cellFormula\",true],[\"cellStyles\",false],[\"cellText\",true],[\"cellDates\",false],[\"sheetStubs\",false],[\"sheetRows\",0,\"n\"],[\"bookDeps\",false],[\"bookSheets\",false],[\"bookProps\",false],[\"bookFiles\",false],[\"bookVBA\",false],[\"password\",\"\"],[\"WTF\",false]])(e)}function Eo(e){Ao([[\"cellDates\",false],[\"bookSST\",false],[\"bookType\",\"xlsx\"],[\"compression\",false],[\"WTF\",false]])(e)}function Fo(e){if(Rn.WS.indexOf(e)>-1)return\"sheet\";if(Rn.CS&&e==Rn.CS)return\"chart\";if(Rn.DS&&e==Rn.DS)return\"dialog\";if(Rn.MS&&e==Rn.MS)return\"macro\";return e&&e.length?e:\"sheet\"}function Do(e,r){if(!e)return 0;try{e=r.map(function a(r){if(!r.id)r.id=r.strRelID;return[r.name,e[\"!id\"][r.id].Target,Fo(e[\"!id\"][r.id].Type)]})}catch(t){return null}return!e||e.length===0?null:e}function Oo(e,r,t,a,n,i,s,l){if(!e||!e[\"!legdrawel\"])return;var o=tt(e[\"!legdrawel\"].Target,a);var c=Zr(t,o,true);if(c)ds(Dt(c),e,l||[])}function No(e,r,t,a,n,i,s,l,o,c,f,u){try{i[a]=Un(Zr(e,t,true),r);var h=Jr(e,r);var d;switch(l){case\"sheet\":d=Gl(h,r,n,o,i[a],c,f,u);break;case\"chart\":d=Yl(h,r,n,o,i[a],c,f,u);if(!d||!d[\"!drawel\"])break;var p=tt(d[\"!drawel\"].Target,r);var m=Ln(p);var v=hs(Zr(e,p,true),Un(Zr(e,m,true),p));var g=tt(v,p);var b=Ln(g);d=Fl(Zr(e,g,true),g,o,Un(Zr(e,b,true),g),c,d);break;case\"macro\":d=Jl(h,r,n,o,i[a],c,f,u);break;case\"dialog\":d=Zl(h,r,n,o,i[a],c,f,u);break;default:throw new Error(\"Unrecognized sheet type \"+l);}s[a]=d;var w=[],k=[];if(i&&i[a])ir(i[a]).forEach(function(t){var n=\"\";if(i[a][t].Type==Rn.CMNT){n=tt(i[a][t].Target,r);w=Ql(Jr(e,n,true),n,o);if(!w||!w.length)return;vs(d,w,false)}if(i[a][t].Type==Rn.TCMNT){n=tt(i[a][t].Target,r);k=k.concat(ws(Jr(e,n,true),o))}});if(k&&k.length)vs(d,k,true,o.people||[]);Oo(d,l,e,r,n,o,c,w)}catch(y){if(o.WTF)throw y}}function Mo(e){return e.charAt(0)==\"/\"?e.slice(1):e}function Io(e,r){He();r=r||{};To(r);if(Gr(e,\"META-INF/manifest.xml\"))return wo(e,r);if(Gr(e,\"objectdata.xml\"))return wo(e,r);if(Gr(e,\"Index/Document.iwa\")){if(typeof Uint8Array==\"undefined\")throw new Error(\"NUMBERS file parsing requires Uint8Array support\");if(typeof parse_numbers_iwa!=\"undefined\"){if(e.FileIndex)return parse_numbers_iwa(e,r);var t=Qe.utils.cfb_new();qr(e).forEach(function(r){Qr(t,r,Kr(e,r))});return parse_numbers_iwa(t,r)}throw new Error(\"Unsupported NUMBERS file\")}if(!Gr(e,\"[Content_Types].xml\")){if(Gr(e,\"index.xml.gz\"))throw new Error(\"Unsupported NUMBERS 08 file\");if(Gr(e,\"index.xml\"))throw new Error(\"Unsupported NUMBERS 09 file\");var a=Qe.find(e,\"Index.zip\");if(a){r=yr(r);delete r.type;if(typeof a.content==\"string\")r.type=\"binary\";if(typeof Bun!==\"undefined\"&&Buffer.isBuffer(a.content))return Xo(new Uint8Array(a.content),r);return Xo(a.content,r)}throw new Error(\"Unsupported ZIP file\")}var n=qr(e);var i=In(Zr(e,\"[Content_Types].xml\"));var s=false;var l,o;if(i.workbooks.length===0){o=\"xl/workbook.xml\";if(Jr(e,o,true))i.workbooks.push(o)}if(i.workbooks.length===0){o=\"xl/workbook.bin\";if(!Jr(e,o,true))throw new Error(\"Could not find workbook\");i.workbooks.push(o);s=true}if(i.workbooks[0].slice(-3)==\"bin\")s=true;var c={};var f={};if(!r.bookSheets&&!r.bookProps){js=[];if(i.sst)try{js=ql(Jr(e,Mo(i.sst)),i.sst,r)}catch(u){if(r.WTF)throw u}if(r.cellStyles&&i.themes.length)c=ss(Zr(e,i.themes[0].replace(/^\\//,\"\"),true)||\"\",r);if(i.style)f=Kl(Jr(e,Mo(i.style)),i.style,c,r)}i.links.map(function(t){try{var a=Un(Zr(e,Ln(Mo(t))),t);return ro(Jr(e,Mo(t)),a,t,r)}catch(n){}});var h=Xl(Jr(e,Mo(i.workbooks[0])),i.workbooks[0],r);var d={},p=\"\";if(i.coreprops.length){p=Jr(e,Mo(i.coreprops[0]),true);if(p)d=Jn(p);if(i.extprops.length!==0){p=Jr(e,Mo(i.extprops[0]),true);if(p)ri(p,d,r)}}var m={};if(!r.bookSheets||r.bookProps){if(i.custprops.length!==0){p=Zr(e,Mo(i.custprops[0]),true);if(p)m=ni(p,r)}}var v={};if(r.bookSheets||r.bookProps){if(h.Sheets)l=h.Sheets.map(function N(e){return e.name});else if(d.Worksheets&&d.SheetNames.length>0)l=d.SheetNames;if(r.bookProps){v.Props=d;v.Custprops=m}if(r.bookSheets&&typeof l!==\"undefined\")v.SheetNames=l;if(r.bookSheets?v.SheetNames:r.bookProps)return v}l={};var g={};if(r.bookDeps&&i.calcchain)g=eo(Jr(e,Mo(i.calcchain)),i.calcchain,r);var b=0;var w={};var k,y;{var x=h.Sheets;d.Worksheets=x.length;d.SheetNames=[];for(var C=0;C!=x.length;++C){d.SheetNames[C]=x[C].name}}var S=s?\"bin\":\"xml\";var _=i.workbooks[0].lastIndexOf(\"/\");var A=(i.workbooks[0].slice(0,_+1)+\"_rels/\"+i.workbooks[0].slice(_+1)+\".rels\").replace(/^\\//,\"\");if(!Gr(e,A))A=\"xl/_rels/workbook.\"+S+\".rels\";var T=Un(Zr(e,A,true),A.replace(/_rels.*/,\"s5s\"));if((i.metadata||[]).length>=1){r.xlmeta=to(Jr(e,Mo(i.metadata[0])),i.metadata[0],r)}if((i.people||[]).length>=1){r.people=ys(Jr(e,Mo(i.people[0])),r)}if(T)T=Do(T,h.Sheets);var E=Jr(e,\"xl/worksheets/sheet.xml\",true)?1:0;e:for(b=0;b!=d.Worksheets;++b){var F=\"sheet\";if(T&&T[b]){k=\"xl/\"+T[b][1].replace(/[\\/]?xl\\//,\"\");if(!Gr(e,k))k=T[b][1];if(!Gr(e,k))k=A.replace(/_rels\\/[\\S\\s]*$/,\"\")+T[b][1];F=T[b][2]}else{k=\"xl/worksheets/sheet\"+(b+1-E)+\".\"+S;k=k.replace(/sheet0\\./,\"sheet.\")}y=k.replace(/^(.*)(\\/)([^\\/]*)$/,\"$1/_rels/$3.rels\");if(r&&r.sheets!=null)switch(typeof r.sheets){case\"number\":if(b!=r.sheets)continue e;break;case\"string\":if(d.SheetNames[b].toLowerCase()!=r.sheets.toLowerCase())continue e;break;default:if(Array.isArray&&Array.isArray(r.sheets)){var D=false;for(var O=0;O!=r.sheets.length;++O){if(typeof r.sheets[O]==\"number\"&&r.sheets[O]==b)D=1;if(typeof r.sheets[O]==\"string\"&&r.sheets[O].toLowerCase()==d.SheetNames[b].toLowerCase())D=1}if(!D)continue e};}No(e,k,y,d.SheetNames[b],b,w,l,F,r,h,c,f)}v={Directory:i,Workbook:h,Props:d,Custprops:m,Deps:g,Sheets:l,SheetNames:d.SheetNames,Strings:js,Styles:f,Themes:c,SSF:yr(q)};if(r&&r.bookFiles){if(e.files){v.keys=n;v.files=e.files}else{v.keys=[];v.files={};e.FullPaths.forEach(function(r,t){r=r.replace(/^Root Entry[\\/]/,\"\");v.keys.push(r);v.files[r]=e.FileIndex[t]})}}if(r&&r.bookVBA){if(i.vba.length>0)v.vbaraw=Jr(e,Mo(i.vba[0]),true);else if(i.defaults&&i.defaults.bin===Cs)v.vbaraw=Jr(e,\"xl/vbaProject.bin\",true)}v.bookType=s?\"xlsb\":\"xlsx\";return v}function Po(e,r){var t=r||{};var a=\"Workbook\",n=Qe.find(e,a);try{a=\"/!DataSpaces/Version\";n=Qe.find(e,a);if(!n||!n.content)throw new Error(\"ECMA-376 Encrypted file missing \"+a);parse_DataSpaceVersionInfo(n.content);a=\"/!DataSpaces/DataSpaceMap\";n=Qe.find(e,a);if(!n||!n.content)throw new Error(\"ECMA-376 Encrypted file missing \"+a);var i=parse_DataSpaceMap(n.content);if(i.length!==1||i[0].comps.length!==1||i[0].comps[0].t!==0||i[0].name!==\"StrongEncryptionDataSpace\"||i[0].comps[0].v!==\"EncryptedPackage\")throw new Error(\"ECMA-376 Encrypted file bad \"+a);a=\"/!DataSpaces/DataSpaceInfo/StrongEncryptionDataSpace\";n=Qe.find(e,a);if(!n||!n.content)throw new Error(\"ECMA-376 Encrypted file missing \"+a);var s=parse_DataSpaceDefinition(n.content);if(s.length!=1||s[0]!=\"StrongEncryptionTransform\")throw new Error(\"ECMA-376 Encrypted file bad \"+a);a=\"/!DataSpaces/TransformInfo/StrongEncryptionTransform/!Primary\";n=Qe.find(e,a);if(!n||!n.content)throw new Error(\"ECMA-376 Encrypted file missing \"+a);\nparse_Primary(n.content)}catch(l){}a=\"/EncryptionInfo\";n=Qe.find(e,a);if(!n||!n.content)throw new Error(\"ECMA-376 Encrypted file missing \"+a);var o=parse_EncryptionInfo(n.content);a=\"/EncryptedPackage\";n=Qe.find(e,a);if(!n||!n.content)throw new Error(\"ECMA-376 Encrypted file missing \"+a);if(o[0]==4&&typeof decrypt_agile!==\"undefined\")return decrypt_agile(o[1],n.content,t.password||\"\",t);if(o[0]==2&&typeof decrypt_std76!==\"undefined\")return decrypt_std76(o[1],n.content,t.password||\"\",t);throw new Error(\"File is password-protected\")}function Ro(e,r){if(e&&!e.SSF){e.SSF=yr(q)}if(e&&e.SSF){He();je(e.SSF);r.revssf=or(e.SSF);r.revssf[e.SSF[65535]]=0;r.ssf=e.SSF}r.rels={};r.wbrels={};r.Strings=[];r.Strings.Count=0;r.Strings.Unique=0;if(Vs)r.revStrings=new Map;else{r.revStrings={};r.revStrings.foo=[];delete r.revStrings.foo}var t=\"bin\";var a=true;var n=Mn();Eo(r=r||{});var i=et();var s=\"\",l=0;r.cellXfs=[];Js(r.cellXfs,{},{revssf:{General:0}});if(!e.Props)e.Props={};s=\"docProps/core.xml\";Qr(i,s,Kn(e.Props,r));n.coreprops.push(s);zn(r.rels,2,s,Rn.CORE_PROPS);s=\"docProps/app.xml\";if(e.Props&&e.Props.SheetNames){}else if(!e.Workbook||!e.Workbook.Sheets)e.Props.SheetNames=e.SheetNames;else{var o=[];for(var c=0;c<e.SheetNames.length;++c)if((e.Workbook.Sheets[c]||{}).Hidden!=2)o.push(e.SheetNames[c]);e.Props.SheetNames=o}e.Props.Worksheets=e.Props.SheetNames.length;Qr(i,s,ti(e.Props,r));n.extprops.push(s);zn(r.rels,3,s,Rn.EXT_PROPS);if(e.Custprops!==e.Props&&ir(e.Custprops||{}).length>0){s=\"docProps/custom.xml\";Qr(i,s,ii(e.Custprops,r));n.custprops.push(s);zn(r.rels,4,s,Rn.CUST_PROPS)}var f=[\"SheetJ5\"];r.tcid=0;for(l=1;l<=e.SheetNames.length;++l){var u={\"!id\":{}};var h=e.Sheets[e.SheetNames[l-1]];var d=(h||{})[\"!type\"]||\"sheet\";switch(d){case\"chart\":;default:s=\"xl/worksheets/sheet\"+l+\".\"+t;Qr(i,s,write_ws_bin(l-1,r,e,u));n.sheets.push(s);zn(r.wbrels,-1,\"worksheets/sheet\"+l+\".\"+t,Rn.WS[0]);}if(h){var p=h[\"!comments\"];var m=false;var v=\"\";if(p&&p.length>0){var g=false;p.forEach(function(e){e[1].forEach(function(e){if(e.T==true)g=true})});if(g){v=\"xl/threadedComments/threadedComment\"+l+\".xml\";Qr(i,v,ks(p,f,r));n.threadedcomments.push(v);zn(u,-1,\"../threadedComments/threadedComment\"+l+\".xml\",Rn.TCMNT)}v=\"xl/comments\"+l+\".\"+t;Qr(i,v,write_comments_bin(p,r));n.comments.push(v);zn(u,-1,\"../comments\"+l+\".\"+t,Rn.CMNT);m=true}if(h[\"!legacy\"]){if(m)Qr(i,\"xl/drawings/vmlDrawing\"+l+\".vml\",ps(l,h[\"!comments\"]))}delete h[\"!comments\"];delete h[\"!legacy\"]}if(u[\"!id\"].rId1)Qr(i,Ln(s),Bn(u))}if(r.Strings!=null&&r.Strings.length>0){s=\"xl/sharedStrings.\"+t;Qr(i,s,write_sst_bin(r.Strings,r));n.strs.push(s);zn(r.wbrels,-1,\"sharedStrings.\"+t,Rn.SST)}s=\"xl/workbook.\"+t;Qr(i,s,write_wb_bin(e,r));n.workbooks.push(s);zn(r.rels,1,s,Rn.WB);s=\"xl/theme/theme1.xml\";var b=ls(e.Themes,r);Qr(i,s,b);n.themes.push(s);zn(r.wbrels,-1,\"theme/theme1.xml\",Rn.THEME);s=\"xl/styles.\"+t;Qr(i,s,write_sty_bin(e,r));n.styles.push(s);zn(r.wbrels,-1,\"styles.\"+t,Rn.STY);if(e.vbaraw&&a){s=\"xl/vbaProject.bin\";Qr(i,s,e.vbaraw);n.vba.push(s);zn(r.wbrels,-1,\"vbaProject.bin\",Rn.VBA)}s=\"xl/metadata.\"+t;Qr(i,s,write_xlmeta_bin());n.metadata.push(s);zn(r.wbrels,-1,\"metadata.\"+t,Rn.XLMETA);if(f.length>1){s=\"xl/persons/person.xml\";Qr(i,s,xs(f,r));n.people.push(s);zn(r.wbrels,-1,\"persons/person.xml\",Rn.PEOPLE)}Qr(i,\"[Content_Types].xml\",Pn(n,r));Qr(i,\"_rels/.rels\",Bn(r.rels));Qr(i,\"xl/_rels/workbook.\"+t+\".rels\",Bn(r.wbrels));delete r.revssf;delete r.ssf;return i}function Lo(e,r){if(e&&!e.SSF){e.SSF=yr(q)}if(e&&e.SSF){He();je(e.SSF);r.revssf=or(e.SSF);r.revssf[e.SSF[65535]]=0;r.ssf=e.SSF}r.rels={};r.wbrels={};r.Strings=[];r.Strings.Count=0;r.Strings.Unique=0;if(Vs)r.revStrings=new Map;else{r.revStrings={};r.revStrings.foo=[];delete r.revStrings.foo}var t=\"xml\";var a=As.indexOf(r.bookType)>-1;var n=Mn();Eo(r=r||{});var i=et();var s=\"\",l=0;r.cellXfs=[];Js(r.cellXfs,{},{revssf:{General:0}});if(!e.Props)e.Props={};s=\"docProps/core.xml\";Qr(i,s,Kn(e.Props,r));n.coreprops.push(s);zn(r.rels,2,s,Rn.CORE_PROPS);s=\"docProps/app.xml\";if(e.Props&&e.Props.SheetNames){}else if(!e.Workbook||!e.Workbook.Sheets)e.Props.SheetNames=e.SheetNames;else{var o=[];for(var c=0;c<e.SheetNames.length;++c)if((e.Workbook.Sheets[c]||{}).Hidden!=2)o.push(e.SheetNames[c]);e.Props.SheetNames=o}e.Props.Worksheets=e.Props.SheetNames.length;Qr(i,s,ti(e.Props,r));n.extprops.push(s);zn(r.rels,3,s,Rn.EXT_PROPS);if(e.Custprops!==e.Props&&ir(e.Custprops||{}).length>0){s=\"docProps/custom.xml\";Qr(i,s,ii(e.Custprops,r));n.custprops.push(s);zn(r.rels,4,s,Rn.CUST_PROPS)}var f=[\"SheetJ5\"];r.tcid=0;for(l=1;l<=e.SheetNames.length;++l){var u={\"!id\":{}};var h=e.Sheets[e.SheetNames[l-1]];var d=(h||{})[\"!type\"]||\"sheet\";switch(d){case\"chart\":;default:s=\"xl/worksheets/sheet\"+l+\".\"+t;Qr(i,s,Tl(l-1,r,e,u));n.sheets.push(s);zn(r.wbrels,-1,\"worksheets/sheet\"+l+\".\"+t,Rn.WS[0]);}if(h){var p=h[\"!comments\"];var m=false;var v=\"\";if(p&&p.length>0){var g=false;p.forEach(function(e){e[1].forEach(function(e){if(e.T==true)g=true})});if(g){v=\"xl/threadedComments/threadedComment\"+l+\".xml\";Qr(i,v,ks(p,f,r));n.threadedcomments.push(v);zn(u,-1,\"../threadedComments/threadedComment\"+l+\".xml\",Rn.TCMNT)}v=\"xl/comments\"+l+\".\"+t;Qr(i,v,bs(p,r));n.comments.push(v);zn(u,-1,\"../comments\"+l+\".\"+t,Rn.CMNT);m=true}if(h[\"!legacy\"]){if(m)Qr(i,\"xl/drawings/vmlDrawing\"+l+\".vml\",ps(l,h[\"!comments\"]))}delete h[\"!comments\"];delete h[\"!legacy\"]}if(u[\"!id\"].rId1)Qr(i,Ln(s),Bn(u))}if(r.Strings!=null&&r.Strings.length>0){s=\"xl/sharedStrings.\"+t;Qr(i,s,Ci(r.Strings,r));n.strs.push(s);zn(r.wbrels,-1,\"sharedStrings.\"+t,Rn.SST)}s=\"xl/workbook.\"+t;Qr(i,s,Vl(e,r));n.workbooks.push(s);zn(r.rels,1,s,Rn.WB);s=\"xl/theme/theme1.xml\";Qr(i,s,ls(e.Themes,r));n.themes.push(s);zn(r.wbrels,-1,\"theme/theme1.xml\",Rn.THEME);s=\"xl/styles.\"+t;Qr(i,s,es(e,r));n.styles.push(s);zn(r.wbrels,-1,\"styles.\"+t,Rn.STY);if(e.vbaraw&&a){s=\"xl/vbaProject.bin\";Qr(i,s,e.vbaraw);n.vba.push(s);zn(r.wbrels,-1,\"vbaProject.bin\",Rn.VBA)}s=\"xl/metadata.\"+t;Qr(i,s,cs());n.metadata.push(s);zn(r.wbrels,-1,\"metadata.\"+t,Rn.XLMETA);if(f.length>1){s=\"xl/persons/person.xml\";Qr(i,s,xs(f,r));n.people.push(s);zn(r.wbrels,-1,\"persons/person.xml\",Rn.PEOPLE)}Qr(i,\"[Content_Types].xml\",Pn(n,r));Qr(i,\"_rels/.rels\",Bn(r.rels));Qr(i,\"xl/_rels/workbook.\"+t+\".rels\",Bn(r.wbrels));delete r.revssf;delete r.ssf;return i}function Uo(e,r){var t=\"\";switch((r||{}).type||\"base64\"){case\"buffer\":return[e[0],e[1],e[2],e[3],e[4],e[5],e[6],e[7]];case\"base64\":t=S(e.slice(0,12));break;case\"binary\":t=e;break;case\"array\":return[e[0],e[1],e[2],e[3],e[4],e[5],e[6],e[7]];default:throw new Error(\"Unrecognized type \"+(r&&r.type||\"undefined\"));}return[t.charCodeAt(0),t.charCodeAt(1),t.charCodeAt(2),t.charCodeAt(3),t.charCodeAt(4),t.charCodeAt(5),t.charCodeAt(6),t.charCodeAt(7)]}function Bo(e,r){if(Qe.find(e,\"EncryptedPackage\"))return Po(e,r);return parse_xlscfb(e,r)}function zo(e,r){var t,a=e;var n=r||{};if(!n.type)n.type=_&&Buffer.isBuffer(e)?\"buffer\":\"base64\";t=rt(a,n);return Io(t,n)}function $o(e,r){var t=0;e:while(t<e.length)switch(e.charCodeAt(t)){case 10:;case 13:;case 32:++t;break;case 60:return parse_xlml(e.slice(t),r);default:break e;}return ui.to_workbook(e,r)}function Wo(e,r){var t=\"\",a=Uo(e,r);switch(r.type){case\"base64\":t=S(e);break;case\"binary\":t=e;break;case\"buffer\":t=e.toString(\"binary\");break;case\"array\":t=kr(e);break;default:throw new Error(\"Unrecognized type \"+r.type);}if(a[0]==239&&a[1]==187&&a[2]==191)t=Dt(t);r.type=\"binary\";return $o(t,r)}function jo(e,r){var t=e;if(r.type==\"base64\")t=S(t);if(typeof ArrayBuffer!==\"undefined\"&&e instanceof ArrayBuffer)t=new Uint8Array(e);t=typeof a!==\"undefined\"?a.utils.decode(1200,t.slice(2),\"str\"):_&&Buffer.isBuffer(e)?e.slice(2).toString(\"utf16le\"):typeof Uint8Array!==\"undefined\"&&t instanceof Uint8Array?typeof TextDecoder!==\"undefined\"?new TextDecoder(\"utf-16le\").decode(t.slice(2)):h(t.slice(2)):u(t.slice(2));r.type=\"binary\";return $o(t,r)}function Ho(e){return!e.match(/[^\\x00-\\x7F]/)?e:Ot(e)}function Vo(e,r,t,a){if(a){t.type=\"string\";return ui.to_workbook(e,t)}return ui.to_workbook(r,t)}function Xo(e,r){c();var t=r||{};if(t.codepage&&typeof a===\"undefined\")console.error(\"Codepage tables are not loaded.  Non-ASCII characters may not give expected results\");if(typeof ArrayBuffer!==\"undefined\"&&e instanceof ArrayBuffer)return Xo(new Uint8Array(e),(t=yr(t),t.type=\"array\",t));if(typeof Int8Array!==\"undefined\"&&e instanceof Int8Array)return Xo(new Uint8Array(e.buffer,e.byteOffset,e.length),t);if(typeof Uint8Array!==\"undefined\"&&e instanceof Uint8Array&&!t.type)t.type=typeof Deno!==\"undefined\"?\"buffer\":\"array\";var n=e,i=[0,0,0,0],s=false;if(t.cellStyles){t.cellNF=true;t.sheetStubs=true}Hs={};if(t.dateNF)Hs.dateNF=t.dateNF;if(!t.type)t.type=_&&Buffer.isBuffer(e)?\"buffer\":\"base64\";if(t.type==\"file\"){t.type=_?\"buffer\":\"binary\";n=nr(e);if(typeof Uint8Array!==\"undefined\"&&!_)t.type=\"array\"}if(t.type==\"string\"){s=true;t.type=\"binary\";t.codepage=65001;n=Ho(e)}if(t.type==\"array\"&&typeof Uint8Array!==\"undefined\"&&e instanceof Uint8Array&&typeof ArrayBuffer!==\"undefined\"){var l=new ArrayBuffer(3),o=new Uint8Array(l);o.foo=\"bar\";if(!o.foo){t=yr(t);t.type=\"array\";return Xo(I(n),t)}}switch((i=Uo(n,t))[0]){case 208:if(i[1]===207&&i[2]===17&&i[3]===224&&i[4]===161&&i[5]===177&&i[6]===26&&i[7]===225)return Bo(Qe.read(n,t),t);break;case 9:if(i[1]<=8)return parse_xlscfb(n,t);break;case 60:return parse_xlml(n,t);case 73:if(i[1]===73&&i[2]===42&&i[3]===0)throw new Error(\"TIFF Image File is not a spreadsheet\");if(i[1]===68)return hi(n,t);break;case 84:if(i[1]===65&&i[2]===66&&i[3]===76)return ci.to_workbook(n,t);break;case 80:return i[1]===75&&i[2]<9&&i[3]<9?zo(n,t):Vo(e,n,t,s);case 239:return i[3]===60?parse_xlml(n,t):Vo(e,n,t,s);case 255:if(i[1]===254){return jo(n,t)}else if(i[1]===0&&i[2]===2&&i[3]===0)return WK_.to_workbook(n,t);break;case 0:if(i[1]===0){if(i[2]>=2&&i[3]===0)return WK_.to_workbook(n,t);if(i[2]===0&&(i[3]===8||i[3]===9))return WK_.to_workbook(n,t)}break;case 3:;case 131:;case 139:;case 140:return li.to_workbook(n,t);case 123:if(i[1]===92&&i[2]===114&&i[3]===116)return rtf_to_workbook(n,t);break;case 10:;case 13:;case 32:return Wo(n,t);case 137:if(i[1]===80&&i[2]===78&&i[3]===71)throw new Error(\"PNG Image File is not a spreadsheet\");break;case 8:if(i[1]===231)throw new Error(\"Unsupported Multiplan 1.x file!\");break;case 12:if(i[1]===236)throw new Error(\"Unsupported Multiplan 2.x file!\");if(i[1]===237)throw new Error(\"Unsupported Multiplan 3.x file!\");break;}if(si.indexOf(i[0])>-1&&i[2]<=12&&i[3]<=31)return li.to_workbook(n,t);return Vo(e,n,t,s)}function Go(e,r){var t=r||{};t.type=\"file\";return Xo(e,t)}function Yo(e,r){switch(r.type){case\"base64\":;case\"binary\":break;case\"buffer\":;case\"array\":r.type=\"\";break;case\"file\":return ar(r.file,Qe.write(e,{type:_?\"buffer\":\"\"}));case\"string\":throw new Error(\"'string' output type invalid for '\"+r.bookType+\"' files\");default:throw new Error(\"Unrecognized type \"+r.type);}return Qe.write(e,r)}function Jo(e,r){switch(r.bookType){case\"ods\":return _o(e,r);case\"numbers\":return write_numbers_iwa(e,r);case\"xlsb\":return Ro(e,r);default:return Lo(e,r);}}function Zo(e,r){var t=yr(r||{});var a=Jo(e,t);return qo(a,t)}function Ko(e,r){var t=yr(r||{});var a=Lo(e,t);return qo(a,t)}function qo(e,r){var t={};var a=_?\"nodebuffer\":typeof Uint8Array!==\"undefined\"?\"array\":\"string\";if(r.compression)t.compression=\"DEFLATE\";if(r.password)t.type=a;else switch(r.type){case\"base64\":t.type=\"base64\";break;case\"binary\":t.type=\"string\";break;case\"string\":throw new Error(\"'string' output type invalid for '\"+r.bookType+\"' files\");case\"buffer\":;case\"file\":t.type=a;break;default:throw new Error(\"Unrecognized type \"+r.type);}var n=e.FullPaths?Qe.write(e,{fileType:\"zip\",type:{nodebuffer:\"buffer\",string:\"binary\"}[t.type]||t.type,compression:!!r.compression}):e.generate(t);if(typeof Deno!==\"undefined\"){if(typeof n==\"string\"){if(r.type==\"binary\"||r.type==\"base64\")return n;n=new Uint8Array(O(n))}}if(r.password&&typeof encrypt_agile!==\"undefined\")return Yo(encrypt_agile(n,r.password),r);if(r.type===\"file\")return ar(r.file,n);return r.type==\"string\"?Dt(n):n}function Qo(e,r){var t=r||{};var a=write_xlscfb(e,t);return Yo(a,t)}function ec(e,r,t){if(!t)t=\"\";var a=t+e;switch(r.type){case\"base64\":return y(Ot(a));case\"binary\":return Ot(a);case\"string\":return e;case\"file\":return ar(r.file,a,\"utf8\");case\"buffer\":{if(_)return A(a,\"utf8\");else if(typeof TextEncoder!==\"undefined\")return(new TextEncoder).encode(a);else return ec(a,{type:\"binary\"}).split(\"\").map(function(e){return e.charCodeAt(0)})};}throw new Error(\"Unrecognized type \"+r.type)}function rc(e,r){switch(r.type){case\"base64\":return x(e);case\"binary\":return e;case\"string\":return e;case\"file\":return ar(r.file,e,\"binary\");case\"buffer\":{if(_)return A(e,\"binary\");else return e.split(\"\").map(function(e){return e.charCodeAt(0)})};}throw new Error(\"Unrecognized type \"+r.type)}function tc(e,r){switch(r.type){case\"string\":;case\"base64\":;case\"binary\":var t=\"\";for(var a=0;a<e.length;++a)t+=String.fromCharCode(e[a]);return r.type==\"base64\"?y(t):r.type==\"string\"?Dt(t):t;case\"file\":return ar(r.file,e);case\"buffer\":return e;default:throw new Error(\"Unrecognized type \"+r.type);}}function ac(e,r){c();Wl(e);var t=yr(r||{});if(t.cellStyles){t.cellNF=true;t.sheetStubs=true}if(t.type==\"array\"){t.type=\"binary\";var a=ac(e,t);t.type=\"array\";return O(a)}return Ko(e,t)}function nc(e,r){c();Wl(e);var t=yr(r||{});if(t.cellStyles){t.cellNF=true;t.sheetStubs=true}if(t.type==\"array\"){t.type=\"binary\";var a=nc(e,t);t.type=\"array\";return O(a)}var n=0;if(t.sheet){if(typeof t.sheet==\"number\")n=t.sheet;else n=e.SheetNames.indexOf(t.sheet);if(!e.SheetNames[n])throw new Error(\"Sheet not found: \"+t.sheet+\" : \"+typeof t.sheet)}switch(t.bookType||\"xlsb\"){case\"xml\":;case\"xlml\":return ec(write_xlml(e,t),t);case\"slk\":;case\"sylk\":return ec(oi.from_sheet(e.Sheets[e.SheetNames[n]],t,e),t);case\"htm\":;case\"html\":return ec(co(e.Sheets[e.SheetNames[n]],t),t);case\"txt\":return rc(pc(e.Sheets[e.SheetNames[n]],t),t);case\"csv\":return ec(dc(e.Sheets[e.SheetNames[n]],t),t,\"\\ufeff\");case\"dif\":return ec(ci.from_sheet(e.Sheets[e.SheetNames[n]],t),t);case\"dbf\":return tc(li.from_sheet(e.Sheets[e.SheetNames[n]],t),t);case\"prn\":return ec(ui.from_sheet(e.Sheets[e.SheetNames[n]],t),t);case\"rtf\":return ec(sheet_to_rtf(e.Sheets[e.SheetNames[n]],t),t);case\"eth\":return ec(fi.from_sheet(e.Sheets[e.SheetNames[n]],t),t);case\"fods\":return ec(_o(e,t),t);case\"wk1\":return tc(WK_.sheet_to_wk1(e.Sheets[e.SheetNames[n]],t),t);case\"wk3\":return tc(WK_.book_to_wk3(e,t),t);case\"biff2\":if(!t.biff)t.biff=2;case\"biff3\":if(!t.biff)t.biff=3;case\"biff4\":if(!t.biff)t.biff=4;return tc(write_biff_buf(e,t),t);case\"biff5\":if(!t.biff)t.biff=5;case\"biff8\":;case\"xla\":;case\"xls\":if(!t.biff)t.biff=8;return Qo(e,t);case\"xlsx\":;case\"xlsm\":;case\"xlam\":;case\"xlsb\":;case\"numbers\":;case\"ods\":return Zo(e,t);default:throw new Error(\"Unrecognized bookType |\"+t.bookType+\"|\");}}function ic(e){if(e.bookType)return;var r={xls:\"biff8\",htm:\"html\",slk:\"sylk\",socialcalc:\"eth\",Sh33tJS:\"WTF\"};var t=e.file.slice(e.file.lastIndexOf(\".\")).toLowerCase();if(t.match(/^\\.[a-z]+$/))e.bookType=t.slice(1);e.bookType=r[e.bookType]||e.bookType}function sc(e,r,t){var a=t||{};a.type=\"file\";a.file=r;ic(a);return nc(e,a)}function lc(e,r,t){var a=t||{};a.type=\"file\";a.file=r;ic(a);return ac(e,a)}function oc(e,r,t,a){var n=t||{};n.type=\"file\";n.file=e;ic(n);n.type=\"buffer\";var i=a;if(!(i instanceof Function))i=t;return er.writeFile(e,nc(r,n),i)}function cc(e,r,t,a,n,i,s){var l=za(t);var o=s.defval,c=s.raw||!Object.prototype.hasOwnProperty.call(s,\"raw\");var f=true,u=e[\"!data\"]!=null;var h=n===1?[]:{};if(n!==1){if(Object.defineProperty)try{Object.defineProperty(h,\"__rowNum__\",{value:t,enumerable:false})}catch(d){h.__rowNum__=t}else h.__rowNum__=t}if(!u||e[\"!data\"][t])for(var p=r.s.c;p<=r.e.c;++p){var m=u?(e[\"!data\"][t]||[])[p]:e[a[p]+l];if(m==null||m.t===undefined){if(o===undefined)continue;if(i[p]!=null){h[i[p]]=o}continue}var v=m.v;switch(m.t){case\"z\":if(v==null)break;continue;case\"e\":v=v==0?null:void 0;break;case\"s\":;case\"b\":;case\"n\":if(!m.z||!Re(m.z))break;v=pr(v);if(typeof v==\"number\")break;case\"d\":if(!(s&&(s.UTC||s.raw===false)))v=Mr(new Date(v));break;default:throw new Error(\"unrecognized type \"+m.t);}if(i[p]!=null){if(v==null){if(m.t==\"e\"&&v===null)h[i[p]]=null;else if(o!==undefined)h[i[p]]=o;else if(c&&v===null)h[i[p]]=null;else continue}else{h[i[p]]=(m.t===\"n\"&&typeof s.rawNumbers===\"boolean\"?s.rawNumbers:c)?v:tn(m,v,s)}if(v!=null)f=false}}return{row:h,isempty:f}}function fc(e,r){if(e==null||e[\"!ref\"]==null)return[];var t={t:\"n\",v:0},a=0,n=1,i=[],s=0,l=\"\";var o={s:{r:0,c:0},e:{r:0,c:0}};var c=r||{};var f=c.range!=null?c.range:e[\"!ref\"];if(c.header===1)a=1;else if(c.header===\"A\")a=2;else if(Array.isArray(c.header))a=3;else if(c.header==null)a=0;switch(typeof f){case\"string\":o=en(f);break;case\"number\":o=en(e[\"!ref\"]);o.s.r=f;break;default:o=f;}if(a>0)n=0;var u=za(o.s.r);var h=[];var d=[];var p=0,m=0;var v=e[\"!data\"]!=null;var g=o.s.r,b=0;var w={};if(v&&!e[\"!data\"][g])e[\"!data\"][g]=[];var k=c.skipHidden&&e[\"!cols\"]||[];var y=c.skipHidden&&e[\"!rows\"]||[];for(b=o.s.c;b<=o.e.c;++b){if((k[b]||{}).hidden)continue;h[b]=Ha(b);t=v?e[\"!data\"][g][b]:e[h[b]+u];switch(a){case 1:i[b]=b-o.s.c;break;case 2:i[b]=h[b];break;case 3:i[b]=c.header[b-o.s.c];break;default:if(t==null)t={w:\"__EMPTY\",t:\"s\"};l=s=tn(t,null,c);m=w[s]||0;if(!m)w[s]=1;else{do{l=s+\"_\"+m++}while(w[l]);w[s]=m;w[l]=1}i[b]=l;}}for(g=o.s.r+n;g<=o.e.r;++g){if((y[g]||{}).hidden)continue;var x=cc(e,o,g,h,a,i,c);if(x.isempty===false||(a===1?c.blankrows!==false:!!c.blankrows))d[p++]=x.row}d.length=p;return d}var uc=/\"/g;function hc(e,r,t,a,n,i,s,l,o){var c=true;var f=[],u=\"\",h=za(t);var d=e[\"!data\"]!=null;var p=d&&e[\"!data\"][t]||[];for(var m=r.s.c;m<=r.e.c;++m){if(!a[m])continue;var v=d?p[m]:e[a[m]+h];if(v==null)u=\"\";else if(v.v!=null){c=false;u=\"\"+(o.rawNumbers&&v.t==\"n\"?v.v:tn(v,null,o));for(var g=0,b=0;g!==u.length;++g)if((b=u.charCodeAt(g))===n||b===i||b===34||o.forceQuotes){u='\"'+u.replace(uc,'\"\"')+'\"';break}if(u==\"ID\"&&l==0&&f.length==0)u='\"ID\"'}else if(v.f!=null&&!v.F){c=false;u=\"=\"+v.f;if(u.indexOf(\",\")>=0)u='\"'+u.replace(uc,'\"\"')+'\"'}else u=\"\";f.push(u)}if(o.strip)while(f[f.length-1]===\"\")--f.length;if(o.blankrows===false&&c)return null;return f.join(s)}function dc(e,r){var t=[];var a=r==null?{}:r;if(e==null||e[\"!ref\"]==null)return\"\";var n=en(e[\"!ref\"]);var i=a.FS!==undefined?a.FS:\",\",s=i.charCodeAt(0);var l=a.RS!==undefined?a.RS:\"\\n\",o=l.charCodeAt(0);var c=\"\",f=[];var u=a.skipHidden&&e[\"!cols\"]||[];var h=a.skipHidden&&e[\"!rows\"]||[];for(var d=n.s.c;d<=n.e.c;++d)if(!(u[d]||{}).hidden)f[d]=Ha(d);var p=0;for(var m=n.s.r;m<=n.e.r;++m){if((h[m]||{}).hidden)continue;c=hc(e,n,m,f,s,o,i,p,a);if(c==null){continue}if(c||a.blankrows!==false)t.push((p++?l:\"\")+c)}return t.join(\"\")}function pc(e,r){if(!r)r={};r.FS=\"\\t\";r.RS=\"\\n\";var t=dc(e,r);if(typeof a==\"undefined\"||r.type==\"string\")return t;var n=a.utils.encode(1200,t,\"str\");return String.fromCharCode(255)+String.fromCharCode(254)+n}function mc(e,r){var t=\"\",a,n=\"\";if(e==null||e[\"!ref\"]==null)return[];var i=en(e[\"!ref\"]),s=\"\",l=[],o;var c=[];var f=e[\"!data\"]!=null;for(o=i.s.c;o<=i.e.c;++o)l[o]=Ha(o);for(var u=i.s.r;u<=i.e.r;++u){s=za(u);for(o=i.s.c;o<=i.e.c;++o){t=l[o]+s;a=f?(e[\"!data\"][u]||[])[o]:e[t];n=\"\";if(a===undefined)continue;else if(a.F!=null){t=a.F;if(!a.f)continue;n=a.f;if(t.indexOf(\":\")==-1)t=t+\":\"+t}if(a.f!=null)n=a.f;else if(r&&r.values===false)continue;else if(a.t==\"z\")continue;else if(a.t==\"n\"&&a.v!=null)n=\"\"+a.v;else if(a.t==\"b\")n=a.v?\"TRUE\":\"FALSE\";else if(a.w!==undefined)n=\"'\"+a.w;else if(a.v===undefined)continue;else if(a.t==\"s\")n=\"'\"+a.v;else n=\"\"+a.v;c[c.length]=t+\"=\"+n}}return c}function vc(e,r,t){var a=t||{};var n=e?e[\"!data\"]!=null:a.dense;if(b!=null&&n==null)n=b;var i=+!a.skipHeader;var s=e||{};if(!e&&n)s[\"!data\"]=[];var l=0,o=0;if(s&&a.origin!=null){if(typeof a.origin==\"number\")l=a.origin;else{var c=typeof a.origin==\"string\"?Ya(a.origin):a.origin;l=c.r;o=c.c}}var f={s:{c:0,r:0},e:{c:o,r:l+r.length-1+i}};if(s[\"!ref\"]){var u=en(s[\"!ref\"]);f.e.c=Math.max(f.e.c,u.e.c);f.e.r=Math.max(f.e.r,u.e.r);if(l==-1){l=u.e.r+1;f.e.r=l+r.length-1+i}}else{if(l==-1){l=0;f.e.r=r.length-1+i}}var h=a.header||[],d=0;var p=[];r.forEach(function(e,r){if(n&&!s[\"!data\"][l+r+i])s[\"!data\"][l+r+i]=[];if(n)p=s[\"!data\"][l+r+i];ir(e).forEach(function(t){if((d=h.indexOf(t))==-1)h[d=h.length]=t;var c=e[t];var f=\"z\";var u=\"\";var m=n?\"\":Ha(o+d)+za(l+r+i);var v=n?p[o+d]:s[m];if(c&&typeof c===\"object\"&&!(c instanceof Date)){if(n)p[o+d]=c;else s[m]=c}else{if(typeof c==\"number\")f=\"n\";else if(typeof c==\"boolean\")f=\"b\";else if(typeof c==\"string\")f=\"s\";else if(c instanceof Date){f=\"d\";if(!a.UTC)c=Ir(c);if(!a.cellDates){f=\"n\";c=dr(c)}u=v!=null&&v.z&&Re(v.z)?v.z:a.dateNF||q[14]}else if(c===null&&a.nullError){f=\"e\";c=0}if(!v){if(!n)s[m]=v={t:f,v:c};else p[o+d]=v={t:f,v:c}}else{v.t=f;v.v=c;delete v.w;delete v.R;if(u)v.z=u}if(u)v.z=u}})});f.e.c=Math.max(f.e.c,o+h.length-1);var m=za(l);if(n&&!s[\"!data\"][l])s[\"!data\"][l]=[];if(i)for(d=0;d<h.length;++d){if(n)s[\"!data\"][l][d+o]={t:\"s\",v:h[d]};else s[Ha(d+o)+m]={t:\"s\",v:h[d]}}s[\"!ref\"]=Ka(f);return s}function gc(e,r){return vc(null,e,r)}function bc(e,r,t){if(typeof r==\"string\"){if(e[\"!data\"]!=null){var a=Ya(r);if(!e[\"!data\"][a.r])e[\"!data\"][a.r]=[];return e[\"!data\"][a.r][a.c]||(e[\"!data\"][a.r][a.c]={t:\"z\"})}return e[r]||(e[r]={t:\"z\"})}if(typeof r!=\"number\")return bc(e,Ja(r));return bc(e,Ha(t||0)+za(r))}function wc(e,r){if(typeof r==\"number\"){if(r>=0&&e.SheetNames.length>r)return r;throw new Error(\"Cannot find sheet # \"+r)}else if(typeof r==\"string\"){var t=e.SheetNames.indexOf(r);if(t>-1)return t;throw new Error(\"Cannot find sheet name |\"+r+\"|\")}else throw new Error(\"Cannot find sheet |\"+r+\"|\")}function kc(e,r){var t={SheetNames:[],Sheets:{}};if(e)yc(t,e,r||\"Sheet1\");return t}function yc(e,r,t,a){var n=1;if(!t)for(;n<=65535;++n,t=undefined)if(e.SheetNames.indexOf(t=\"Sheet\"+n)==-1)break;if(!t||e.SheetNames.length>=65535)throw new Error(\"Too many worksheets\");if(a&&e.SheetNames.indexOf(t)>=0&&t.length<32){var i=t.match(/\\d+$/);n=i&&+i[0]||0;var s=i&&t.slice(0,i.index)||t;for(++n;n<=65535;++n)if(e.SheetNames.indexOf(t=s+n)==-1)break}zl(t);if(e.SheetNames.indexOf(t)>=0)throw new Error(\"Worksheet with name |\"+t+\"| already exists!\");e.SheetNames.push(t);e.Sheets[t]=r;return t}function xc(e,r,t){if(!e.Workbook)e.Workbook={};if(!e.Workbook.Sheets)e.Workbook.Sheets=[];var a=wc(e,r);if(!e.Workbook.Sheets[a])e.Workbook.Sheets[a]={};switch(t){case 0:;case 1:;case 2:break;default:throw new Error(\"Bad sheet visibility setting \"+t);}e.Workbook.Sheets[a].Hidden=t}function Cc(e,r){e.z=r;return e}function Sc(e,r,t){if(!r){delete e.l}else{e.l={Target:r};if(t)e.l.Tooltip=t}return e}function _c(e,r,t){return Sc(e,\"#\"+r,t)}function Ac(e,r,t){if(!e.c)e.c=[];e.c.push({t:r,a:t||\"SheetJS\"})}function Tc(e,r,t,a){var n=typeof r!=\"string\"?r:en(r);var i=typeof r==\"string\"?r:Ka(r);for(var s=n.s.r;s<=n.e.r;++s)for(var l=n.s.c;l<=n.e.c;++l){var o=bc(e,s,l);o.t=\"n\";o.F=i;delete o.v;if(s==n.s.r&&l==n.s.c){o.f=t;if(a)o.D=true}}var c=Za(e[\"!ref\"]);if(c.s.r>n.s.r)c.s.r=n.s.r;if(c.s.c>n.s.c)c.s.c=n.s.c;if(c.e.r<n.e.r)c.e.r=n.e.r;if(c.e.c<n.e.c)c.e.c=n.e.c;e[\"!ref\"]=Ka(c);return e}var Ec={encode_col:Ha,encode_row:za,encode_cell:Ja,encode_range:Ka,decode_col:ja,decode_row:Ba,split_cell:Ga,decode_cell:Ya,decode_range:Za,format_cell:tn,sheet_new:nn,sheet_add_aoa:sn,sheet_add_json:vc,sheet_add_dom:fo,aoa_to_sheet:ln,json_to_sheet:gc,table_to_sheet:uo,table_to_book:ho,sheet_to_csv:dc,sheet_to_txt:pc,sheet_to_json:fc,sheet_to_html:co,sheet_to_formulae:mc,sheet_to_row_object_array:fc,sheet_get_cell:bc,book_new:kc,book_append_sheet:yc,book_set_sheet_visibility:xc,cell_set_number_format:Cc,cell_set_hyperlink:Sc,cell_set_internal_link:_c,cell_add_comment:Ac,sheet_set_array_formula:Tc,consts:{SHEET_VISIBLE:0,SHEET_HIDDEN:1,SHEET_VERY_HIDDEN:2}};if(typeof parse_xlscfb!==\"undefined\")e.parse_xlscfb=parse_xlscfb;e.parse_zip=Io;e.read=Xo;e.readFile=Go;e.readFileSync=Go;e.write=nc;e.writeFile=sc;e.writeFileSync=sc;e.writeFileAsync=oc;e.utils=Ec;e.writeXLSX=ac;e.writeFileXLSX=lc;e.set_fs=rr;e.set_cptable=g;e.SSF=Ve;if(typeof __stream!==\"undefined\")e.stream=__stream;if(typeof Qe!==\"undefined\")e.CFB=Qe;if(typeof require!==\"undefined\"){var Fc=undefined;if((Fc||{}).Readable)set_readable(Fc.Readable);try{er=undefined}catch(Ms){}}}if(typeof exports!==\"undefined\")make_xlsx_lib(exports);else if(typeof module!==\"undefined\"&&module.exports)make_xlsx_lib(module.exports);else if(typeof define===\"function\"&&define.amd)define(\"xlsx\",function(){if(!XLSX.version)make_xlsx_lib(XLSX);return XLSX});else make_xlsx_lib(XLSX);if(typeof window!==\"undefined\"&&!window.XLSX)try{window.XLSX=XLSX}catch(e){}\n\n;\n/*\nThe MIT Licence.\r\n\r\nCopyright (c) 2025 Michael Mclaughlin\r\n\r\nPermission is hereby granted, free of charge, to any person obtaining\r\na copy of this software and associated documentation files (the\r\n'Software'), to deal in the Software without restriction, including\r\nwithout limitation the rights to use, copy, modify, merge, publish,\r\ndistribute, sublicense, and/or sell copies of the Software, and to\r\npermit persons to whom the Software is furnished to do so, subject to\r\nthe following conditions:\r\n\r\nThe above copyright notice and this permission notice shall be\r\nincluded in all copies or substantial portions of the Software.\r\n\r\nTHE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,\r\nEXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF\r\nMERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.\r\nIN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY\r\nCLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,\r\nTORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE\r\nSOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\r\n\r\n\n*/\n;(function (globalScope) {\r\n  'use strict';\r\n\r\n\r\n  /*!\r\n   *  decimal.js v10.6.0\r\n   *  An arbitrary-precision Decimal type for JavaScript.\r\n   *  https://github.com/MikeMcl/decimal.js\r\n   *  Copyright (c) 2025 Michael Mclaughlin <M8ch88l@gmail.com>\r\n   *  MIT Licence\r\n   */\r\n\r\n\r\n  // -----------------------------------  EDITABLE DEFAULTS  ------------------------------------ //\r\n\r\n\r\n    // The maximum exponent magnitude.\r\n    // The limit on the value of `toExpNeg`, `toExpPos`, `minE` and `maxE`.\r\n  var EXP_LIMIT = 9e15,                      // 0 to 9e15\r\n\r\n    // The limit on the value of `precision`, and on the value of the first argument to\r\n    // `toDecimalPlaces`, `toExponential`, `toFixed`, `toPrecision` and `toSignificantDigits`.\r\n    MAX_DIGITS = 1e9,                        // 0 to 1e9\r\n\r\n    // Base conversion alphabet.\r\n    NUMERALS = '0123456789abcdef',\r\n\r\n    // The natural logarithm of 10 (1025 digits).\r\n    LN10 = '2.3025850929940456840179914546843642076011014886287729760333279009675726096773524802359972050895982983419677840422862486334095254650828067566662873690987816894829072083255546808437998948262331985283935053089653777326288461633662222876982198867465436674744042432743651550489343149393914796194044002221051017141748003688084012647080685567743216228355220114804663715659121373450747856947683463616792101806445070648000277502684916746550586856935673420670581136429224554405758925724208241314695689016758940256776311356919292033376587141660230105703089634572075440370847469940168269282808481184289314848524948644871927809676271275775397027668605952496716674183485704422507197965004714951050492214776567636938662976979522110718264549734772662425709429322582798502585509785265383207606726317164309505995087807523710333101197857547331541421808427543863591778117054309827482385045648019095610299291824318237525357709750539565187697510374970888692180205189339507238539205144634197265287286965110862571492198849978748873771345686209167058',\r\n\r\n    // Pi (1025 digits).\r\n    PI = '3.1415926535897932384626433832795028841971693993751058209749445923078164062862089986280348253421170679821480865132823066470938446095505822317253594081284811174502841027019385211055596446229489549303819644288109756659334461284756482337867831652712019091456485669234603486104543266482133936072602491412737245870066063155881748815209209628292540917153643678925903600113305305488204665213841469519415116094330572703657595919530921861173819326117931051185480744623799627495673518857527248912279381830119491298336733624406566430860213949463952247371907021798609437027705392171762931767523846748184676694051320005681271452635608277857713427577896091736371787214684409012249534301465495853710507922796892589235420199561121290219608640344181598136297747713099605187072113499999983729780499510597317328160963185950244594553469083026425223082533446850352619311881710100031378387528865875332083814206171776691473035982534904287554687311595628638823537875937519577818577805321712268066130019278766111959092164201989380952572010654858632789',\r\n\r\n\r\n    // The initial configuration properties of the Decimal constructor.\r\n    DEFAULTS = {\r\n\r\n      // These values must be integers within the stated ranges (inclusive).\r\n      // Most of these values can be changed at run-time using the `Decimal.config` method.\r\n\r\n      // The maximum number of significant digits of the result of a calculation or base conversion.\r\n      // E.g. `Decimal.config({ precision: 20 });`\r\n      precision: 20,                         // 1 to MAX_DIGITS\r\n\r\n      // The rounding mode used when rounding to `precision`.\r\n      //\r\n      // ROUND_UP         0 Away from zero.\r\n      // ROUND_DOWN       1 Towards zero.\r\n      // ROUND_CEIL       2 Towards +Infinity.\r\n      // ROUND_FLOOR      3 Towards -Infinity.\r\n      // ROUND_HALF_UP    4 Towards nearest neighbour. If equidistant, up.\r\n      // ROUND_HALF_DOWN  5 Towards nearest neighbour. If equidistant, down.\r\n      // ROUND_HALF_EVEN  6 Towards nearest neighbour. If equidistant, towards even neighbour.\r\n      // ROUND_HALF_CEIL  7 Towards nearest neighbour. If equidistant, towards +Infinity.\r\n      // ROUND_HALF_FLOOR 8 Towards nearest neighbour. If equidistant, towards -Infinity.\r\n      //\r\n      // E.g.\r\n      // `Decimal.rounding = 4;`\r\n      // `Decimal.rounding = Decimal.ROUND_HALF_UP;`\r\n      rounding: 4,                           // 0 to 8\r\n\r\n      // The modulo mode used when calculating the modulus: a mod n.\r\n      // The quotient (q = a / n) is calculated according to the corresponding rounding mode.\r\n      // The remainder (r) is calculated as: r = a - n * q.\r\n      //\r\n      // UP         0 The remainder is positive if the dividend is negative, else is negative.\r\n      // DOWN       1 The remainder has the same sign as the dividend (JavaScript %).\r\n      // FLOOR      3 The remainder has the same sign as the divisor (Python %).\r\n      // HALF_EVEN  6 The IEEE 754 remainder function.\r\n      // EUCLID     9 Euclidian division. q = sign(n) * floor(a / abs(n)). Always positive.\r\n      //\r\n      // Truncated division (1), floored division (3), the IEEE 754 remainder (6), and Euclidian\r\n      // division (9) are commonly used for the modulus operation. The other rounding modes can also\r\n      // be used, but they may not give useful results.\r\n      modulo: 1,                             // 0 to 9\r\n\r\n      // The exponent value at and beneath which `toString` returns exponential notation.\r\n      // JavaScript numbers: -7\r\n      toExpNeg: -7,                          // 0 to -EXP_LIMIT\r\n\r\n      // The exponent value at and above which `toString` returns exponential notation.\r\n      // JavaScript numbers: 21\r\n      toExpPos:  21,                         // 0 to EXP_LIMIT\r\n\r\n      // The minimum exponent value, beneath which underflow to zero occurs.\r\n      // JavaScript numbers: -324  (5e-324)\r\n      minE: -EXP_LIMIT,                      // -1 to -EXP_LIMIT\r\n\r\n      // The maximum exponent value, above which overflow to Infinity occurs.\r\n      // JavaScript numbers: 308  (1.7976931348623157e+308)\r\n      maxE: EXP_LIMIT,                       // 1 to EXP_LIMIT\r\n\r\n      // Whether to use cryptographically-secure random number generation, if available.\r\n      crypto: false                          // true/false\r\n    },\r\n\r\n\r\n  // ----------------------------------- END OF EDITABLE DEFAULTS ------------------------------- //\r\n\r\n\r\n    Decimal, inexact, noConflict, quadrant,\r\n    external = true,\r\n\r\n    decimalError = '[DecimalError] ',\r\n    invalidArgument = decimalError + 'Invalid argument: ',\r\n    precisionLimitExceeded = decimalError + 'Precision limit exceeded',\r\n    cryptoUnavailable = decimalError + 'crypto unavailable',\r\n    tag = '[object Decimal]',\r\n\r\n    mathfloor = Math.floor,\r\n    mathpow = Math.pow,\r\n\r\n    isBinary = /^0b([01]+(\\.[01]*)?|\\.[01]+)(p[+-]?\\d+)?$/i,\r\n    isHex = /^0x([0-9a-f]+(\\.[0-9a-f]*)?|\\.[0-9a-f]+)(p[+-]?\\d+)?$/i,\r\n    isOctal = /^0o([0-7]+(\\.[0-7]*)?|\\.[0-7]+)(p[+-]?\\d+)?$/i,\r\n    isDecimal = /^(\\d+(\\.\\d*)?|\\.\\d+)(e[+-]?\\d+)?$/i,\r\n\r\n    BASE = 1e7,\r\n    LOG_BASE = 7,\r\n    MAX_SAFE_INTEGER = 9007199254740991,\r\n\r\n    LN10_PRECISION = LN10.length - 1,\r\n    PI_PRECISION = PI.length - 1,\r\n\r\n    // Decimal.prototype object\r\n    P = { toStringTag: tag };\r\n\r\n\r\n  // Decimal prototype methods\r\n\r\n\r\n  /*\r\n   *  absoluteValue             abs\r\n   *  ceil\r\n   *  clampedTo                 clamp\r\n   *  comparedTo                cmp\r\n   *  cosine                    cos\r\n   *  cubeRoot                  cbrt\r\n   *  decimalPlaces             dp\r\n   *  dividedBy                 div\r\n   *  dividedToIntegerBy        divToInt\r\n   *  equals                    eq\r\n   *  floor\r\n   *  greaterThan               gt\r\n   *  greaterThanOrEqualTo      gte\r\n   *  hyperbolicCosine          cosh\r\n   *  hyperbolicSine            sinh\r\n   *  hyperbolicTangent         tanh\r\n   *  inverseCosine             acos\r\n   *  inverseHyperbolicCosine   acosh\r\n   *  inverseHyperbolicSine     asinh\r\n   *  inverseHyperbolicTangent  atanh\r\n   *  inverseSine               asin\r\n   *  inverseTangent            atan\r\n   *  isFinite\r\n   *  isInteger                 isInt\r\n   *  isNaN\r\n   *  isNegative                isNeg\r\n   *  isPositive                isPos\r\n   *  isZero\r\n   *  lessThan                  lt\r\n   *  lessThanOrEqualTo         lte\r\n   *  logarithm                 log\r\n   *  [maximum]                 [max]\r\n   *  [minimum]                 [min]\r\n   *  minus                     sub\r\n   *  modulo                    mod\r\n   *  naturalExponential        exp\r\n   *  naturalLogarithm          ln\r\n   *  negated                   neg\r\n   *  plus                      add\r\n   *  precision                 sd\r\n   *  round\r\n   *  sine                      sin\r\n   *  squareRoot                sqrt\r\n   *  tangent                   tan\r\n   *  times                     mul\r\n   *  toBinary\r\n   *  toDecimalPlaces           toDP\r\n   *  toExponential\r\n   *  toFixed\r\n   *  toFraction\r\n   *  toHexadecimal             toHex\r\n   *  toNearest\r\n   *  toNumber\r\n   *  toOctal\r\n   *  toPower                   pow\r\n   *  toPrecision\r\n   *  toSignificantDigits       toSD\r\n   *  toString\r\n   *  truncated                 trunc\r\n   *  valueOf                   toJSON\r\n   */\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the absolute value of this Decimal.\r\n   *\r\n   */\r\n  P.absoluteValue = P.abs = function () {\r\n    var x = new this.constructor(this);\r\n    if (x.s < 0) x.s = 1;\r\n    return finalise(x);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the value of this Decimal rounded to a whole number in the\r\n   * direction of positive Infinity.\r\n   *\r\n   */\r\n  P.ceil = function () {\r\n    return finalise(new this.constructor(this), this.e + 1, 2);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the value of this Decimal clamped to the range\r\n   * delineated by `min` and `max`.\r\n   *\r\n   * min {number|string|bigint|Decimal}\r\n   * max {number|string|bigint|Decimal}\r\n   *\r\n   */\r\n  P.clampedTo = P.clamp = function (min, max) {\r\n    var k,\r\n      x = this,\r\n      Ctor = x.constructor;\r\n    min = new Ctor(min);\r\n    max = new Ctor(max);\r\n    if (!min.s || !max.s) return new Ctor(NaN);\r\n    if (min.gt(max)) throw Error(invalidArgument + max);\r\n    k = x.cmp(min);\r\n    return k < 0 ? min : x.cmp(max) > 0 ? max : new Ctor(x);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return\r\n   *   1    if the value of this Decimal is greater than the value of `y`,\r\n   *  -1    if the value of this Decimal is less than the value of `y`,\r\n   *   0    if they have the same value,\r\n   *   NaN  if the value of either Decimal is NaN.\r\n   *\r\n   */\r\n  P.comparedTo = P.cmp = function (y) {\r\n    var i, j, xdL, ydL,\r\n      x = this,\r\n      xd = x.d,\r\n      yd = (y = new x.constructor(y)).d,\r\n      xs = x.s,\r\n      ys = y.s;\r\n\r\n    // Either NaN or ±Infinity?\r\n    if (!xd || !yd) {\r\n      return !xs || !ys ? NaN : xs !== ys ? xs : xd === yd ? 0 : !xd ^ xs < 0 ? 1 : -1;\r\n    }\r\n\r\n    // Either zero?\r\n    if (!xd[0] || !yd[0]) return xd[0] ? xs : yd[0] ? -ys : 0;\r\n\r\n    // Signs differ?\r\n    if (xs !== ys) return xs;\r\n\r\n    // Compare exponents.\r\n    if (x.e !== y.e) return x.e > y.e ^ xs < 0 ? 1 : -1;\r\n\r\n    xdL = xd.length;\r\n    ydL = yd.length;\r\n\r\n    // Compare digit by digit.\r\n    for (i = 0, j = xdL < ydL ? xdL : ydL; i < j; ++i) {\r\n      if (xd[i] !== yd[i]) return xd[i] > yd[i] ^ xs < 0 ? 1 : -1;\r\n    }\r\n\r\n    // Compare lengths.\r\n    return xdL === ydL ? 0 : xdL > ydL ^ xs < 0 ? 1 : -1;\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the cosine of the value in radians of this Decimal.\r\n   *\r\n   * Domain: [-Infinity, Infinity]\r\n   * Range: [-1, 1]\r\n   *\r\n   * cos(0)         = 1\r\n   * cos(-0)        = 1\r\n   * cos(Infinity)  = NaN\r\n   * cos(-Infinity) = NaN\r\n   * cos(NaN)       = NaN\r\n   *\r\n   */\r\n  P.cosine = P.cos = function () {\r\n    var pr, rm,\r\n      x = this,\r\n      Ctor = x.constructor;\r\n\r\n    if (!x.d) return new Ctor(NaN);\r\n\r\n    // cos(0) = cos(-0) = 1\r\n    if (!x.d[0]) return new Ctor(1);\r\n\r\n    pr = Ctor.precision;\r\n    rm = Ctor.rounding;\r\n    Ctor.precision = pr + Math.max(x.e, x.sd()) + LOG_BASE;\r\n    Ctor.rounding = 1;\r\n\r\n    x = cosine(Ctor, toLessThanHalfPi(Ctor, x));\r\n\r\n    Ctor.precision = pr;\r\n    Ctor.rounding = rm;\r\n\r\n    return finalise(quadrant == 2 || quadrant == 3 ? x.neg() : x, pr, rm, true);\r\n  };\r\n\r\n\r\n  /*\r\n   *\r\n   * Return a new Decimal whose value is the cube root of the value of this Decimal, rounded to\r\n   * `precision` significant digits using rounding mode `rounding`.\r\n   *\r\n   *  cbrt(0)  =  0\r\n   *  cbrt(-0) = -0\r\n   *  cbrt(1)  =  1\r\n   *  cbrt(-1) = -1\r\n   *  cbrt(N)  =  N\r\n   *  cbrt(-I) = -I\r\n   *  cbrt(I)  =  I\r\n   *\r\n   * Math.cbrt(x) = (x < 0 ? -Math.pow(-x, 1/3) : Math.pow(x, 1/3))\r\n   *\r\n   */\r\n  P.cubeRoot = P.cbrt = function () {\r\n    var e, m, n, r, rep, s, sd, t, t3, t3plusx,\r\n      x = this,\r\n      Ctor = x.constructor;\r\n\r\n    if (!x.isFinite() || x.isZero()) return new Ctor(x);\r\n    external = false;\r\n\r\n    // Initial estimate.\r\n    s = x.s * mathpow(x.s * x, 1 / 3);\r\n\r\n     // Math.cbrt underflow/overflow?\r\n     // Pass x to Math.pow as integer, then adjust the exponent of the result.\r\n    if (!s || Math.abs(s) == 1 / 0) {\r\n      n = digitsToString(x.d);\r\n      e = x.e;\r\n\r\n      // Adjust n exponent so it is a multiple of 3 away from x exponent.\r\n      if (s = (e - n.length + 1) % 3) n += (s == 1 || s == -2 ? '0' : '00');\r\n      s = mathpow(n, 1 / 3);\r\n\r\n      // Rarely, e may be one less than the result exponent value.\r\n      e = mathfloor((e + 1) / 3) - (e % 3 == (e < 0 ? -1 : 2));\r\n\r\n      if (s == 1 / 0) {\r\n        n = '5e' + e;\r\n      } else {\r\n        n = s.toExponential();\r\n        n = n.slice(0, n.indexOf('e') + 1) + e;\r\n      }\r\n\r\n      r = new Ctor(n);\r\n      r.s = x.s;\r\n    } else {\r\n      r = new Ctor(s.toString());\r\n    }\r\n\r\n    sd = (e = Ctor.precision) + 3;\r\n\r\n    // Halley's method.\r\n    // TODO? Compare Newton's method.\r\n    for (;;) {\r\n      t = r;\r\n      t3 = t.times(t).times(t);\r\n      t3plusx = t3.plus(x);\r\n      r = divide(t3plusx.plus(x).times(t), t3plusx.plus(t3), sd + 2, 1);\r\n\r\n      // TODO? Replace with for-loop and checkRoundingDigits.\r\n      if (digitsToString(t.d).slice(0, sd) === (n = digitsToString(r.d)).slice(0, sd)) {\r\n        n = n.slice(sd - 3, sd + 1);\r\n\r\n        // The 4th rounding digit may be in error by -1 so if the 4 rounding digits are 9999 or 4999\r\n        // , i.e. approaching a rounding boundary, continue the iteration.\r\n        if (n == '9999' || !rep && n == '4999') {\r\n\r\n          // On the first iteration only, check to see if rounding up gives the exact result as the\r\n          // nines may infinitely repeat.\r\n          if (!rep) {\r\n            finalise(t, e + 1, 0);\r\n\r\n            if (t.times(t).times(t).eq(x)) {\r\n              r = t;\r\n              break;\r\n            }\r\n          }\r\n\r\n          sd += 4;\r\n          rep = 1;\r\n        } else {\r\n\r\n          // If the rounding digits are null, 0{0,4} or 50{0,3}, check for an exact result.\r\n          // If not, then there are further digits and m will be truthy.\r\n          if (!+n || !+n.slice(1) && n.charAt(0) == '5') {\r\n\r\n            // Truncate to the first rounding digit.\r\n            finalise(r, e + 1, 1);\r\n            m = !r.times(r).times(r).eq(x);\r\n          }\r\n\r\n          break;\r\n        }\r\n      }\r\n    }\r\n\r\n    external = true;\r\n\r\n    return finalise(r, e, Ctor.rounding, m);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return the number of decimal places of the value of this Decimal.\r\n   *\r\n   */\r\n  P.decimalPlaces = P.dp = function () {\r\n    var w,\r\n      d = this.d,\r\n      n = NaN;\r\n\r\n    if (d) {\r\n      w = d.length - 1;\r\n      n = (w - mathfloor(this.e / LOG_BASE)) * LOG_BASE;\r\n\r\n      // Subtract the number of trailing zeros of the last word.\r\n      w = d[w];\r\n      if (w) for (; w % 10 == 0; w /= 10) n--;\r\n      if (n < 0) n = 0;\r\n    }\r\n\r\n    return n;\r\n  };\r\n\r\n\r\n  /*\r\n   *  n / 0 = I\r\n   *  n / N = N\r\n   *  n / I = 0\r\n   *  0 / n = 0\r\n   *  0 / 0 = N\r\n   *  0 / N = N\r\n   *  0 / I = 0\r\n   *  N / n = N\r\n   *  N / 0 = N\r\n   *  N / N = N\r\n   *  N / I = N\r\n   *  I / n = I\r\n   *  I / 0 = I\r\n   *  I / N = N\r\n   *  I / I = N\r\n   *\r\n   * Return a new Decimal whose value is the value of this Decimal divided by `y`, rounded to\r\n   * `precision` significant digits using rounding mode `rounding`.\r\n   *\r\n   */\r\n  P.dividedBy = P.div = function (y) {\r\n    return divide(this, new this.constructor(y));\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the integer part of dividing the value of this Decimal\r\n   * by the value of `y`, rounded to `precision` significant digits using rounding mode `rounding`.\r\n   *\r\n   */\r\n  P.dividedToIntegerBy = P.divToInt = function (y) {\r\n    var x = this,\r\n      Ctor = x.constructor;\r\n    return finalise(divide(x, new Ctor(y), 0, 1, 1), Ctor.precision, Ctor.rounding);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return true if the value of this Decimal is equal to the value of `y`, otherwise return false.\r\n   *\r\n   */\r\n  P.equals = P.eq = function (y) {\r\n    return this.cmp(y) === 0;\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the value of this Decimal rounded to a whole number in the\r\n   * direction of negative Infinity.\r\n   *\r\n   */\r\n  P.floor = function () {\r\n    return finalise(new this.constructor(this), this.e + 1, 3);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return true if the value of this Decimal is greater than the value of `y`, otherwise return\r\n   * false.\r\n   *\r\n   */\r\n  P.greaterThan = P.gt = function (y) {\r\n    return this.cmp(y) > 0;\r\n  };\r\n\r\n\r\n  /*\r\n   * Return true if the value of this Decimal is greater than or equal to the value of `y`,\r\n   * otherwise return false.\r\n   *\r\n   */\r\n  P.greaterThanOrEqualTo = P.gte = function (y) {\r\n    var k = this.cmp(y);\r\n    return k == 1 || k === 0;\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the hyperbolic cosine of the value in radians of this\r\n   * Decimal.\r\n   *\r\n   * Domain: [-Infinity, Infinity]\r\n   * Range: [1, Infinity]\r\n   *\r\n   * cosh(x) = 1 + x^2/2! + x^4/4! + x^6/6! + ...\r\n   *\r\n   * cosh(0)         = 1\r\n   * cosh(-0)        = 1\r\n   * cosh(Infinity)  = Infinity\r\n   * cosh(-Infinity) = Infinity\r\n   * cosh(NaN)       = NaN\r\n   *\r\n   *  x        time taken (ms)   result\r\n   * 1000      9                 9.8503555700852349694e+433\r\n   * 10000     25                4.4034091128314607936e+4342\r\n   * 100000    171               1.4033316802130615897e+43429\r\n   * 1000000   3817              1.5166076984010437725e+434294\r\n   * 10000000  abandoned after 2 minute wait\r\n   *\r\n   * TODO? Compare performance of cosh(x) = 0.5 * (exp(x) + exp(-x))\r\n   *\r\n   */\r\n  P.hyperbolicCosine = P.cosh = function () {\r\n    var k, n, pr, rm, len,\r\n      x = this,\r\n      Ctor = x.constructor,\r\n      one = new Ctor(1);\r\n\r\n    if (!x.isFinite()) return new Ctor(x.s ? 1 / 0 : NaN);\r\n    if (x.isZero()) return one;\r\n\r\n    pr = Ctor.precision;\r\n    rm = Ctor.rounding;\r\n    Ctor.precision = pr + Math.max(x.e, x.sd()) + 4;\r\n    Ctor.rounding = 1;\r\n    len = x.d.length;\r\n\r\n    // Argument reduction: cos(4x) = 1 - 8cos^2(x) + 8cos^4(x) + 1\r\n    // i.e. cos(x) = 1 - cos^2(x/4)(8 - 8cos^2(x/4))\r\n\r\n    // Estimate the optimum number of times to use the argument reduction.\r\n    // TODO? Estimation reused from cosine() and may not be optimal here.\r\n    if (len < 32) {\r\n      k = Math.ceil(len / 3);\r\n      n = (1 / tinyPow(4, k)).toString();\r\n    } else {\r\n      k = 16;\r\n      n = '2.3283064365386962890625e-10';\r\n    }\r\n\r\n    x = taylorSeries(Ctor, 1, x.times(n), new Ctor(1), true);\r\n\r\n    // Reverse argument reduction\r\n    var cosh2_x,\r\n      i = k,\r\n      d8 = new Ctor(8);\r\n    for (; i--;) {\r\n      cosh2_x = x.times(x);\r\n      x = one.minus(cosh2_x.times(d8.minus(cosh2_x.times(d8))));\r\n    }\r\n\r\n    return finalise(x, Ctor.precision = pr, Ctor.rounding = rm, true);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the hyperbolic sine of the value in radians of this\r\n   * Decimal.\r\n   *\r\n   * Domain: [-Infinity, Infinity]\r\n   * Range: [-Infinity, Infinity]\r\n   *\r\n   * sinh(x) = x + x^3/3! + x^5/5! + x^7/7! + ...\r\n   *\r\n   * sinh(0)         = 0\r\n   * sinh(-0)        = -0\r\n   * sinh(Infinity)  = Infinity\r\n   * sinh(-Infinity) = -Infinity\r\n   * sinh(NaN)       = NaN\r\n   *\r\n   * x        time taken (ms)\r\n   * 10       2 ms\r\n   * 100      5 ms\r\n   * 1000     14 ms\r\n   * 10000    82 ms\r\n   * 100000   886 ms            1.4033316802130615897e+43429\r\n   * 200000   2613 ms\r\n   * 300000   5407 ms\r\n   * 400000   8824 ms\r\n   * 500000   13026 ms          8.7080643612718084129e+217146\r\n   * 1000000  48543 ms\r\n   *\r\n   * TODO? Compare performance of sinh(x) = 0.5 * (exp(x) - exp(-x))\r\n   *\r\n   */\r\n  P.hyperbolicSine = P.sinh = function () {\r\n    var k, pr, rm, len,\r\n      x = this,\r\n      Ctor = x.constructor;\r\n\r\n    if (!x.isFinite() || x.isZero()) return new Ctor(x);\r\n\r\n    pr = Ctor.precision;\r\n    rm = Ctor.rounding;\r\n    Ctor.precision = pr + Math.max(x.e, x.sd()) + 4;\r\n    Ctor.rounding = 1;\r\n    len = x.d.length;\r\n\r\n    if (len < 3) {\r\n      x = taylorSeries(Ctor, 2, x, x, true);\r\n    } else {\r\n\r\n      // Alternative argument reduction: sinh(3x) = sinh(x)(3 + 4sinh^2(x))\r\n      // i.e. sinh(x) = sinh(x/3)(3 + 4sinh^2(x/3))\r\n      // 3 multiplications and 1 addition\r\n\r\n      // Argument reduction: sinh(5x) = sinh(x)(5 + sinh^2(x)(20 + 16sinh^2(x)))\r\n      // i.e. sinh(x) = sinh(x/5)(5 + sinh^2(x/5)(20 + 16sinh^2(x/5)))\r\n      // 4 multiplications and 2 additions\r\n\r\n      // Estimate the optimum number of times to use the argument reduction.\r\n      k = 1.4 * Math.sqrt(len);\r\n      k = k > 16 ? 16 : k | 0;\r\n\r\n      x = x.times(1 / tinyPow(5, k));\r\n      x = taylorSeries(Ctor, 2, x, x, true);\r\n\r\n      // Reverse argument reduction\r\n      var sinh2_x,\r\n        d5 = new Ctor(5),\r\n        d16 = new Ctor(16),\r\n        d20 = new Ctor(20);\r\n      for (; k--;) {\r\n        sinh2_x = x.times(x);\r\n        x = x.times(d5.plus(sinh2_x.times(d16.times(sinh2_x).plus(d20))));\r\n      }\r\n    }\r\n\r\n    Ctor.precision = pr;\r\n    Ctor.rounding = rm;\r\n\r\n    return finalise(x, pr, rm, true);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the hyperbolic tangent of the value in radians of this\r\n   * Decimal.\r\n   *\r\n   * Domain: [-Infinity, Infinity]\r\n   * Range: [-1, 1]\r\n   *\r\n   * tanh(x) = sinh(x) / cosh(x)\r\n   *\r\n   * tanh(0)         = 0\r\n   * tanh(-0)        = -0\r\n   * tanh(Infinity)  = 1\r\n   * tanh(-Infinity) = -1\r\n   * tanh(NaN)       = NaN\r\n   *\r\n   */\r\n  P.hyperbolicTangent = P.tanh = function () {\r\n    var pr, rm,\r\n      x = this,\r\n      Ctor = x.constructor;\r\n\r\n    if (!x.isFinite()) return new Ctor(x.s);\r\n    if (x.isZero()) return new Ctor(x);\r\n\r\n    pr = Ctor.precision;\r\n    rm = Ctor.rounding;\r\n    Ctor.precision = pr + 7;\r\n    Ctor.rounding = 1;\r\n\r\n    return divide(x.sinh(), x.cosh(), Ctor.precision = pr, Ctor.rounding = rm);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the arccosine (inverse cosine) in radians of the value of\r\n   * this Decimal.\r\n   *\r\n   * Domain: [-1, 1]\r\n   * Range: [0, pi]\r\n   *\r\n   * acos(x) = pi/2 - asin(x)\r\n   *\r\n   * acos(0)       = pi/2\r\n   * acos(-0)      = pi/2\r\n   * acos(1)       = 0\r\n   * acos(-1)      = pi\r\n   * acos(1/2)     = pi/3\r\n   * acos(-1/2)    = 2*pi/3\r\n   * acos(|x| > 1) = NaN\r\n   * acos(NaN)     = NaN\r\n   *\r\n   */\r\n  P.inverseCosine = P.acos = function () {\r\n    var x = this,\r\n      Ctor = x.constructor,\r\n      k = x.abs().cmp(1),\r\n      pr = Ctor.precision,\r\n      rm = Ctor.rounding;\r\n\r\n    if (k !== -1) {\r\n      return k === 0\r\n        // |x| is 1\r\n        ? x.isNeg() ? getPi(Ctor, pr, rm) : new Ctor(0)\r\n        // |x| > 1 or x is NaN\r\n        : new Ctor(NaN);\r\n    }\r\n\r\n    if (x.isZero()) return getPi(Ctor, pr + 4, rm).times(0.5);\r\n\r\n    // TODO? Special case acos(0.5) = pi/3 and acos(-0.5) = 2*pi/3\r\n\r\n    Ctor.precision = pr + 6;\r\n    Ctor.rounding = 1;\r\n\r\n    // See https://github.com/MikeMcl/decimal.js/pull/217\r\n    x = new Ctor(1).minus(x).div(x.plus(1)).sqrt().atan();\r\n\r\n    Ctor.precision = pr;\r\n    Ctor.rounding = rm;\r\n\r\n    return x.times(2);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the inverse of the hyperbolic cosine in radians of the\r\n   * value of this Decimal.\r\n   *\r\n   * Domain: [1, Infinity]\r\n   * Range: [0, Infinity]\r\n   *\r\n   * acosh(x) = ln(x + sqrt(x^2 - 1))\r\n   *\r\n   * acosh(x < 1)     = NaN\r\n   * acosh(NaN)       = NaN\r\n   * acosh(Infinity)  = Infinity\r\n   * acosh(-Infinity) = NaN\r\n   * acosh(0)         = NaN\r\n   * acosh(-0)        = NaN\r\n   * acosh(1)         = 0\r\n   * acosh(-1)        = NaN\r\n   *\r\n   */\r\n  P.inverseHyperbolicCosine = P.acosh = function () {\r\n    var pr, rm,\r\n      x = this,\r\n      Ctor = x.constructor;\r\n\r\n    if (x.lte(1)) return new Ctor(x.eq(1) ? 0 : NaN);\r\n    if (!x.isFinite()) return new Ctor(x);\r\n\r\n    pr = Ctor.precision;\r\n    rm = Ctor.rounding;\r\n    Ctor.precision = pr + Math.max(Math.abs(x.e), x.sd()) + 4;\r\n    Ctor.rounding = 1;\r\n    external = false;\r\n\r\n    x = x.times(x).minus(1).sqrt().plus(x);\r\n\r\n    external = true;\r\n    Ctor.precision = pr;\r\n    Ctor.rounding = rm;\r\n\r\n    return x.ln();\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the inverse of the hyperbolic sine in radians of the value\r\n   * of this Decimal.\r\n   *\r\n   * Domain: [-Infinity, Infinity]\r\n   * Range: [-Infinity, Infinity]\r\n   *\r\n   * asinh(x) = ln(x + sqrt(x^2 + 1))\r\n   *\r\n   * asinh(NaN)       = NaN\r\n   * asinh(Infinity)  = Infinity\r\n   * asinh(-Infinity) = -Infinity\r\n   * asinh(0)         = 0\r\n   * asinh(-0)        = -0\r\n   *\r\n   */\r\n  P.inverseHyperbolicSine = P.asinh = function () {\r\n    var pr, rm,\r\n      x = this,\r\n      Ctor = x.constructor;\r\n\r\n    if (!x.isFinite() || x.isZero()) return new Ctor(x);\r\n\r\n    pr = Ctor.precision;\r\n    rm = Ctor.rounding;\r\n    Ctor.precision = pr + 2 * Math.max(Math.abs(x.e), x.sd()) + 6;\r\n    Ctor.rounding = 1;\r\n    external = false;\r\n\r\n    x = x.times(x).plus(1).sqrt().plus(x);\r\n\r\n    external = true;\r\n    Ctor.precision = pr;\r\n    Ctor.rounding = rm;\r\n\r\n    return x.ln();\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the inverse of the hyperbolic tangent in radians of the\r\n   * value of this Decimal.\r\n   *\r\n   * Domain: [-1, 1]\r\n   * Range: [-Infinity, Infinity]\r\n   *\r\n   * atanh(x) = 0.5 * ln((1 + x) / (1 - x))\r\n   *\r\n   * atanh(|x| > 1)   = NaN\r\n   * atanh(NaN)       = NaN\r\n   * atanh(Infinity)  = NaN\r\n   * atanh(-Infinity) = NaN\r\n   * atanh(0)         = 0\r\n   * atanh(-0)        = -0\r\n   * atanh(1)         = Infinity\r\n   * atanh(-1)        = -Infinity\r\n   *\r\n   */\r\n  P.inverseHyperbolicTangent = P.atanh = function () {\r\n    var pr, rm, wpr, xsd,\r\n      x = this,\r\n      Ctor = x.constructor;\r\n\r\n    if (!x.isFinite()) return new Ctor(NaN);\r\n    if (x.e >= 0) return new Ctor(x.abs().eq(1) ? x.s / 0 : x.isZero() ? x : NaN);\r\n\r\n    pr = Ctor.precision;\r\n    rm = Ctor.rounding;\r\n    xsd = x.sd();\r\n\r\n    if (Math.max(xsd, pr) < 2 * -x.e - 1) return finalise(new Ctor(x), pr, rm, true);\r\n\r\n    Ctor.precision = wpr = xsd - x.e;\r\n\r\n    x = divide(x.plus(1), new Ctor(1).minus(x), wpr + pr, 1);\r\n\r\n    Ctor.precision = pr + 4;\r\n    Ctor.rounding = 1;\r\n\r\n    x = x.ln();\r\n\r\n    Ctor.precision = pr;\r\n    Ctor.rounding = rm;\r\n\r\n    return x.times(0.5);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the arcsine (inverse sine) in radians of the value of this\r\n   * Decimal.\r\n   *\r\n   * Domain: [-Infinity, Infinity]\r\n   * Range: [-pi/2, pi/2]\r\n   *\r\n   * asin(x) = 2*atan(x/(1 + sqrt(1 - x^2)))\r\n   *\r\n   * asin(0)       = 0\r\n   * asin(-0)      = -0\r\n   * asin(1/2)     = pi/6\r\n   * asin(-1/2)    = -pi/6\r\n   * asin(1)       = pi/2\r\n   * asin(-1)      = -pi/2\r\n   * asin(|x| > 1) = NaN\r\n   * asin(NaN)     = NaN\r\n   *\r\n   * TODO? Compare performance of Taylor series.\r\n   *\r\n   */\r\n  P.inverseSine = P.asin = function () {\r\n    var halfPi, k,\r\n      pr, rm,\r\n      x = this,\r\n      Ctor = x.constructor;\r\n\r\n    if (x.isZero()) return new Ctor(x);\r\n\r\n    k = x.abs().cmp(1);\r\n    pr = Ctor.precision;\r\n    rm = Ctor.rounding;\r\n\r\n    if (k !== -1) {\r\n\r\n      // |x| is 1\r\n      if (k === 0) {\r\n        halfPi = getPi(Ctor, pr + 4, rm).times(0.5);\r\n        halfPi.s = x.s;\r\n        return halfPi;\r\n      }\r\n\r\n      // |x| > 1 or x is NaN\r\n      return new Ctor(NaN);\r\n    }\r\n\r\n    // TODO? Special case asin(1/2) = pi/6 and asin(-1/2) = -pi/6\r\n\r\n    Ctor.precision = pr + 6;\r\n    Ctor.rounding = 1;\r\n\r\n    x = x.div(new Ctor(1).minus(x.times(x)).sqrt().plus(1)).atan();\r\n\r\n    Ctor.precision = pr;\r\n    Ctor.rounding = rm;\r\n\r\n    return x.times(2);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the arctangent (inverse tangent) in radians of the value\r\n   * of this Decimal.\r\n   *\r\n   * Domain: [-Infinity, Infinity]\r\n   * Range: [-pi/2, pi/2]\r\n   *\r\n   * atan(x) = x - x^3/3 + x^5/5 - x^7/7 + ...\r\n   *\r\n   * atan(0)         = 0\r\n   * atan(-0)        = -0\r\n   * atan(1)         = pi/4\r\n   * atan(-1)        = -pi/4\r\n   * atan(Infinity)  = pi/2\r\n   * atan(-Infinity) = -pi/2\r\n   * atan(NaN)       = NaN\r\n   *\r\n   */\r\n  P.inverseTangent = P.atan = function () {\r\n    var i, j, k, n, px, t, r, wpr, x2,\r\n      x = this,\r\n      Ctor = x.constructor,\r\n      pr = Ctor.precision,\r\n      rm = Ctor.rounding;\r\n\r\n    if (!x.isFinite()) {\r\n      if (!x.s) return new Ctor(NaN);\r\n      if (pr + 4 <= PI_PRECISION) {\r\n        r = getPi(Ctor, pr + 4, rm).times(0.5);\r\n        r.s = x.s;\r\n        return r;\r\n      }\r\n    } else if (x.isZero()) {\r\n      return new Ctor(x);\r\n    } else if (x.abs().eq(1) && pr + 4 <= PI_PRECISION) {\r\n      r = getPi(Ctor, pr + 4, rm).times(0.25);\r\n      r.s = x.s;\r\n      return r;\r\n    }\r\n\r\n    Ctor.precision = wpr = pr + 10;\r\n    Ctor.rounding = 1;\r\n\r\n    // TODO? if (x >= 1 && pr <= PI_PRECISION) atan(x) = halfPi * x.s - atan(1 / x);\r\n\r\n    // Argument reduction\r\n    // Ensure |x| < 0.42\r\n    // atan(x) = 2 * atan(x / (1 + sqrt(1 + x^2)))\r\n\r\n    k = Math.min(28, wpr / LOG_BASE + 2 | 0);\r\n\r\n    for (i = k; i; --i) x = x.div(x.times(x).plus(1).sqrt().plus(1));\r\n\r\n    external = false;\r\n\r\n    j = Math.ceil(wpr / LOG_BASE);\r\n    n = 1;\r\n    x2 = x.times(x);\r\n    r = new Ctor(x);\r\n    px = x;\r\n\r\n    // atan(x) = x - x^3/3 + x^5/5 - x^7/7 + ...\r\n    for (; i !== -1;) {\r\n      px = px.times(x2);\r\n      t = r.minus(px.div(n += 2));\r\n\r\n      px = px.times(x2);\r\n      r = t.plus(px.div(n += 2));\r\n\r\n      if (r.d[j] !== void 0) for (i = j; r.d[i] === t.d[i] && i--;);\r\n    }\r\n\r\n    if (k) r = r.times(2 << (k - 1));\r\n\r\n    external = true;\r\n\r\n    return finalise(r, Ctor.precision = pr, Ctor.rounding = rm, true);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return true if the value of this Decimal is a finite number, otherwise return false.\r\n   *\r\n   */\r\n  P.isFinite = function () {\r\n    return !!this.d;\r\n  };\r\n\r\n\r\n  /*\r\n   * Return true if the value of this Decimal is an integer, otherwise return false.\r\n   *\r\n   */\r\n  P.isInteger = P.isInt = function () {\r\n    return !!this.d && mathfloor(this.e / LOG_BASE) > this.d.length - 2;\r\n  };\r\n\r\n\r\n  /*\r\n   * Return true if the value of this Decimal is NaN, otherwise return false.\r\n   *\r\n   */\r\n  P.isNaN = function () {\r\n    return !this.s;\r\n  };\r\n\r\n\r\n  /*\r\n   * Return true if the value of this Decimal is negative, otherwise return false.\r\n   *\r\n   */\r\n  P.isNegative = P.isNeg = function () {\r\n    return this.s < 0;\r\n  };\r\n\r\n\r\n  /*\r\n   * Return true if the value of this Decimal is positive, otherwise return false.\r\n   *\r\n   */\r\n  P.isPositive = P.isPos = function () {\r\n    return this.s > 0;\r\n  };\r\n\r\n\r\n  /*\r\n   * Return true if the value of this Decimal is 0 or -0, otherwise return false.\r\n   *\r\n   */\r\n  P.isZero = function () {\r\n    return !!this.d && this.d[0] === 0;\r\n  };\r\n\r\n\r\n  /*\r\n   * Return true if the value of this Decimal is less than `y`, otherwise return false.\r\n   *\r\n   */\r\n  P.lessThan = P.lt = function (y) {\r\n    return this.cmp(y) < 0;\r\n  };\r\n\r\n\r\n  /*\r\n   * Return true if the value of this Decimal is less than or equal to `y`, otherwise return false.\r\n   *\r\n   */\r\n  P.lessThanOrEqualTo = P.lte = function (y) {\r\n    return this.cmp(y) < 1;\r\n  };\r\n\r\n\r\n  /*\r\n   * Return the logarithm of the value of this Decimal to the specified base, rounded to `precision`\r\n   * significant digits using rounding mode `rounding`.\r\n   *\r\n   * If no base is specified, return log[10](arg).\r\n   *\r\n   * log[base](arg) = ln(arg) / ln(base)\r\n   *\r\n   * The result will always be correctly rounded if the base of the log is 10, and 'almost always'\r\n   * otherwise:\r\n   *\r\n   * Depending on the rounding mode, the result may be incorrectly rounded if the first fifteen\r\n   * rounding digits are [49]99999999999999 or [50]00000000000000. In that case, the maximum error\r\n   * between the result and the correctly rounded result will be one ulp (unit in the last place).\r\n   *\r\n   * log[-b](a)       = NaN\r\n   * log[0](a)        = NaN\r\n   * log[1](a)        = NaN\r\n   * log[NaN](a)      = NaN\r\n   * log[Infinity](a) = NaN\r\n   * log[b](0)        = -Infinity\r\n   * log[b](-0)       = -Infinity\r\n   * log[b](-a)       = NaN\r\n   * log[b](1)        = 0\r\n   * log[b](Infinity) = Infinity\r\n   * log[b](NaN)      = NaN\r\n   *\r\n   * [base] {number|string|bigint|Decimal} The base of the logarithm.\r\n   *\r\n   */\r\n  P.logarithm = P.log = function (base) {\r\n    var isBase10, d, denominator, k, inf, num, sd, r,\r\n      arg = this,\r\n      Ctor = arg.constructor,\r\n      pr = Ctor.precision,\r\n      rm = Ctor.rounding,\r\n      guard = 5;\r\n\r\n    // Default base is 10.\r\n    if (base == null) {\r\n      base = new Ctor(10);\r\n      isBase10 = true;\r\n    } else {\r\n      base = new Ctor(base);\r\n      d = base.d;\r\n\r\n      // Return NaN if base is negative, or non-finite, or is 0 or 1.\r\n      if (base.s < 0 || !d || !d[0] || base.eq(1)) return new Ctor(NaN);\r\n\r\n      isBase10 = base.eq(10);\r\n    }\r\n\r\n    d = arg.d;\r\n\r\n    // Is arg negative, non-finite, 0 or 1?\r\n    if (arg.s < 0 || !d || !d[0] || arg.eq(1)) {\r\n      return new Ctor(d && !d[0] ? -1 / 0 : arg.s != 1 ? NaN : d ? 0 : 1 / 0);\r\n    }\r\n\r\n    // The result will have a non-terminating decimal expansion if base is 10 and arg is not an\r\n    // integer power of 10.\r\n    if (isBase10) {\r\n      if (d.length > 1) {\r\n        inf = true;\r\n      } else {\r\n        for (k = d[0]; k % 10 === 0;) k /= 10;\r\n        inf = k !== 1;\r\n      }\r\n    }\r\n\r\n    external = false;\r\n    sd = pr + guard;\r\n    num = naturalLogarithm(arg, sd);\r\n    denominator = isBase10 ? getLn10(Ctor, sd + 10) : naturalLogarithm(base, sd);\r\n\r\n    // The result will have 5 rounding digits.\r\n    r = divide(num, denominator, sd, 1);\r\n\r\n    // If at a rounding boundary, i.e. the result's rounding digits are [49]9999 or [50]0000,\r\n    // calculate 10 further digits.\r\n    //\r\n    // If the result is known to have an infinite decimal expansion, repeat this until it is clear\r\n    // that the result is above or below the boundary. Otherwise, if after calculating the 10\r\n    // further digits, the last 14 are nines, round up and assume the result is exact.\r\n    // Also assume the result is exact if the last 14 are zero.\r\n    //\r\n    // Example of a result that will be incorrectly rounded:\r\n    // log[1048576](4503599627370502) = 2.60000000000000009610279511444746...\r\n    // The above result correctly rounded using ROUND_CEIL to 1 decimal place should be 2.7, but it\r\n    // will be given as 2.6 as there are 15 zeros immediately after the requested decimal place, so\r\n    // the exact result would be assumed to be 2.6, which rounded using ROUND_CEIL to 1 decimal\r\n    // place is still 2.6.\r\n    if (checkRoundingDigits(r.d, k = pr, rm)) {\r\n\r\n      do {\r\n        sd += 10;\r\n        num = naturalLogarithm(arg, sd);\r\n        denominator = isBase10 ? getLn10(Ctor, sd + 10) : naturalLogarithm(base, sd);\r\n        r = divide(num, denominator, sd, 1);\r\n\r\n        if (!inf) {\r\n\r\n          // Check for 14 nines from the 2nd rounding digit, as the first may be 4.\r\n          if (+digitsToString(r.d).slice(k + 1, k + 15) + 1 == 1e14) {\r\n            r = finalise(r, pr + 1, 0);\r\n          }\r\n\r\n          break;\r\n        }\r\n      } while (checkRoundingDigits(r.d, k += 10, rm));\r\n    }\r\n\r\n    external = true;\r\n\r\n    return finalise(r, pr, rm);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the maximum of the arguments and the value of this Decimal.\r\n   *\r\n   * arguments {number|string|bigint|Decimal}\r\n   *\r\n  P.max = function () {\r\n    Array.prototype.push.call(arguments, this);\r\n    return maxOrMin(this.constructor, arguments, -1);\r\n  };\r\n   */\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the minimum of the arguments and the value of this Decimal.\r\n   *\r\n   * arguments {number|string|bigint|Decimal}\r\n   *\r\n  P.min = function () {\r\n    Array.prototype.push.call(arguments, this);\r\n    return maxOrMin(this.constructor, arguments, 1);\r\n  };\r\n   */\r\n\r\n\r\n  /*\r\n   *  n - 0 = n\r\n   *  n - N = N\r\n   *  n - I = -I\r\n   *  0 - n = -n\r\n   *  0 - 0 = 0\r\n   *  0 - N = N\r\n   *  0 - I = -I\r\n   *  N - n = N\r\n   *  N - 0 = N\r\n   *  N - N = N\r\n   *  N - I = N\r\n   *  I - n = I\r\n   *  I - 0 = I\r\n   *  I - N = N\r\n   *  I - I = N\r\n   *\r\n   * Return a new Decimal whose value is the value of this Decimal minus `y`, rounded to `precision`\r\n   * significant digits using rounding mode `rounding`.\r\n   *\r\n   */\r\n  P.minus = P.sub = function (y) {\r\n    var d, e, i, j, k, len, pr, rm, xd, xe, xLTy, yd,\r\n      x = this,\r\n      Ctor = x.constructor;\r\n\r\n    y = new Ctor(y);\r\n\r\n    // If either is not finite...\r\n    if (!x.d || !y.d) {\r\n\r\n      // Return NaN if either is NaN.\r\n      if (!x.s || !y.s) y = new Ctor(NaN);\r\n\r\n      // Return y negated if x is finite and y is ±Infinity.\r\n      else if (x.d) y.s = -y.s;\r\n\r\n      // Return x if y is finite and x is ±Infinity.\r\n      // Return x if both are ±Infinity with different signs.\r\n      // Return NaN if both are ±Infinity with the same sign.\r\n      else y = new Ctor(y.d || x.s !== y.s ? x : NaN);\r\n\r\n      return y;\r\n    }\r\n\r\n    // If signs differ...\r\n    if (x.s != y.s) {\r\n      y.s = -y.s;\r\n      return x.plus(y);\r\n    }\r\n\r\n    xd = x.d;\r\n    yd = y.d;\r\n    pr = Ctor.precision;\r\n    rm = Ctor.rounding;\r\n\r\n    // If either is zero...\r\n    if (!xd[0] || !yd[0]) {\r\n\r\n      // Return y negated if x is zero and y is non-zero.\r\n      if (yd[0]) y.s = -y.s;\r\n\r\n      // Return x if y is zero and x is non-zero.\r\n      else if (xd[0]) y = new Ctor(x);\r\n\r\n      // Return zero if both are zero.\r\n      // From IEEE 754 (2008) 6.3: 0 - 0 = -0 - -0 = -0 when rounding to -Infinity.\r\n      else return new Ctor(rm === 3 ? -0 : 0);\r\n\r\n      return external ? finalise(y, pr, rm) : y;\r\n    }\r\n\r\n    // x and y are finite, non-zero numbers with the same sign.\r\n\r\n    // Calculate base 1e7 exponents.\r\n    e = mathfloor(y.e / LOG_BASE);\r\n    xe = mathfloor(x.e / LOG_BASE);\r\n\r\n    xd = xd.slice();\r\n    k = xe - e;\r\n\r\n    // If base 1e7 exponents differ...\r\n    if (k) {\r\n      xLTy = k < 0;\r\n\r\n      if (xLTy) {\r\n        d = xd;\r\n        k = -k;\r\n        len = yd.length;\r\n      } else {\r\n        d = yd;\r\n        e = xe;\r\n        len = xd.length;\r\n      }\r\n\r\n      // Numbers with massively different exponents would result in a very high number of\r\n      // zeros needing to be prepended, but this can be avoided while still ensuring correct\r\n      // rounding by limiting the number of zeros to `Math.ceil(pr / LOG_BASE) + 2`.\r\n      i = Math.max(Math.ceil(pr / LOG_BASE), len) + 2;\r\n\r\n      if (k > i) {\r\n        k = i;\r\n        d.length = 1;\r\n      }\r\n\r\n      // Prepend zeros to equalise exponents.\r\n      d.reverse();\r\n      for (i = k; i--;) d.push(0);\r\n      d.reverse();\r\n\r\n    // Base 1e7 exponents equal.\r\n    } else {\r\n\r\n      // Check digits to determine which is the bigger number.\r\n\r\n      i = xd.length;\r\n      len = yd.length;\r\n      xLTy = i < len;\r\n      if (xLTy) len = i;\r\n\r\n      for (i = 0; i < len; i++) {\r\n        if (xd[i] != yd[i]) {\r\n          xLTy = xd[i] < yd[i];\r\n          break;\r\n        }\r\n      }\r\n\r\n      k = 0;\r\n    }\r\n\r\n    if (xLTy) {\r\n      d = xd;\r\n      xd = yd;\r\n      yd = d;\r\n      y.s = -y.s;\r\n    }\r\n\r\n    len = xd.length;\r\n\r\n    // Append zeros to `xd` if shorter.\r\n    // Don't add zeros to `yd` if shorter as subtraction only needs to start at `yd` length.\r\n    for (i = yd.length - len; i > 0; --i) xd[len++] = 0;\r\n\r\n    // Subtract yd from xd.\r\n    for (i = yd.length; i > k;) {\r\n\r\n      if (xd[--i] < yd[i]) {\r\n        for (j = i; j && xd[--j] === 0;) xd[j] = BASE - 1;\r\n        --xd[j];\r\n        xd[i] += BASE;\r\n      }\r\n\r\n      xd[i] -= yd[i];\r\n    }\r\n\r\n    // Remove trailing zeros.\r\n    for (; xd[--len] === 0;) xd.pop();\r\n\r\n    // Remove leading zeros and adjust exponent accordingly.\r\n    for (; xd[0] === 0; xd.shift()) --e;\r\n\r\n    // Zero?\r\n    if (!xd[0]) return new Ctor(rm === 3 ? -0 : 0);\r\n\r\n    y.d = xd;\r\n    y.e = getBase10Exponent(xd, e);\r\n\r\n    return external ? finalise(y, pr, rm) : y;\r\n  };\r\n\r\n\r\n  /*\r\n   *   n % 0 =  N\r\n   *   n % N =  N\r\n   *   n % I =  n\r\n   *   0 % n =  0\r\n   *  -0 % n = -0\r\n   *   0 % 0 =  N\r\n   *   0 % N =  N\r\n   *   0 % I =  0\r\n   *   N % n =  N\r\n   *   N % 0 =  N\r\n   *   N % N =  N\r\n   *   N % I =  N\r\n   *   I % n =  N\r\n   *   I % 0 =  N\r\n   *   I % N =  N\r\n   *   I % I =  N\r\n   *\r\n   * Return a new Decimal whose value is the value of this Decimal modulo `y`, rounded to\r\n   * `precision` significant digits using rounding mode `rounding`.\r\n   *\r\n   * The result depends on the modulo mode.\r\n   *\r\n   */\r\n  P.modulo = P.mod = function (y) {\r\n    var q,\r\n      x = this,\r\n      Ctor = x.constructor;\r\n\r\n    y = new Ctor(y);\r\n\r\n    // Return NaN if x is ±Infinity or NaN, or y is NaN or ±0.\r\n    if (!x.d || !y.s || y.d && !y.d[0]) return new Ctor(NaN);\r\n\r\n    // Return x if y is ±Infinity or x is ±0.\r\n    if (!y.d || x.d && !x.d[0]) {\r\n      return finalise(new Ctor(x), Ctor.precision, Ctor.rounding);\r\n    }\r\n\r\n    // Prevent rounding of intermediate calculations.\r\n    external = false;\r\n\r\n    if (Ctor.modulo == 9) {\r\n\r\n      // Euclidian division: q = sign(y) * floor(x / abs(y))\r\n      // result = x - q * y    where  0 <= result < abs(y)\r\n      q = divide(x, y.abs(), 0, 3, 1);\r\n      q.s *= y.s;\r\n    } else {\r\n      q = divide(x, y, 0, Ctor.modulo, 1);\r\n    }\r\n\r\n    q = q.times(y);\r\n\r\n    external = true;\r\n\r\n    return x.minus(q);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the natural exponential of the value of this Decimal,\r\n   * i.e. the base e raised to the power the value of this Decimal, rounded to `precision`\r\n   * significant digits using rounding mode `rounding`.\r\n   *\r\n   */\r\n  P.naturalExponential = P.exp = function () {\r\n    return naturalExponential(this);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the natural logarithm of the value of this Decimal,\r\n   * rounded to `precision` significant digits using rounding mode `rounding`.\r\n   *\r\n   */\r\n  P.naturalLogarithm = P.ln = function () {\r\n    return naturalLogarithm(this);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the value of this Decimal negated, i.e. as if multiplied by\r\n   * -1.\r\n   *\r\n   */\r\n  P.negated = P.neg = function () {\r\n    var x = new this.constructor(this);\r\n    x.s = -x.s;\r\n    return finalise(x);\r\n  };\r\n\r\n\r\n  /*\r\n   *  n + 0 = n\r\n   *  n + N = N\r\n   *  n + I = I\r\n   *  0 + n = n\r\n   *  0 + 0 = 0\r\n   *  0 + N = N\r\n   *  0 + I = I\r\n   *  N + n = N\r\n   *  N + 0 = N\r\n   *  N + N = N\r\n   *  N + I = N\r\n   *  I + n = I\r\n   *  I + 0 = I\r\n   *  I + N = N\r\n   *  I + I = I\r\n   *\r\n   * Return a new Decimal whose value is the value of this Decimal plus `y`, rounded to `precision`\r\n   * significant digits using rounding mode `rounding`.\r\n   *\r\n   */\r\n  P.plus = P.add = function (y) {\r\n    var carry, d, e, i, k, len, pr, rm, xd, yd,\r\n      x = this,\r\n      Ctor = x.constructor;\r\n\r\n    y = new Ctor(y);\r\n\r\n    // If either is not finite...\r\n    if (!x.d || !y.d) {\r\n\r\n      // Return NaN if either is NaN.\r\n      if (!x.s || !y.s) y = new Ctor(NaN);\r\n\r\n      // Return x if y is finite and x is ±Infinity.\r\n      // Return x if both are ±Infinity with the same sign.\r\n      // Return NaN if both are ±Infinity with different signs.\r\n      // Return y if x is finite and y is ±Infinity.\r\n      else if (!x.d) y = new Ctor(y.d || x.s === y.s ? x : NaN);\r\n\r\n      return y;\r\n    }\r\n\r\n     // If signs differ...\r\n    if (x.s != y.s) {\r\n      y.s = -y.s;\r\n      return x.minus(y);\r\n    }\r\n\r\n    xd = x.d;\r\n    yd = y.d;\r\n    pr = Ctor.precision;\r\n    rm = Ctor.rounding;\r\n\r\n    // If either is zero...\r\n    if (!xd[0] || !yd[0]) {\r\n\r\n      // Return x if y is zero.\r\n      // Return y if y is non-zero.\r\n      if (!yd[0]) y = new Ctor(x);\r\n\r\n      return external ? finalise(y, pr, rm) : y;\r\n    }\r\n\r\n    // x and y are finite, non-zero numbers with the same sign.\r\n\r\n    // Calculate base 1e7 exponents.\r\n    k = mathfloor(x.e / LOG_BASE);\r\n    e = mathfloor(y.e / LOG_BASE);\r\n\r\n    xd = xd.slice();\r\n    i = k - e;\r\n\r\n    // If base 1e7 exponents differ...\r\n    if (i) {\r\n\r\n      if (i < 0) {\r\n        d = xd;\r\n        i = -i;\r\n        len = yd.length;\r\n      } else {\r\n        d = yd;\r\n        e = k;\r\n        len = xd.length;\r\n      }\r\n\r\n      // Limit number of zeros prepended to max(ceil(pr / LOG_BASE), len) + 1.\r\n      k = Math.ceil(pr / LOG_BASE);\r\n      len = k > len ? k + 1 : len + 1;\r\n\r\n      if (i > len) {\r\n        i = len;\r\n        d.length = 1;\r\n      }\r\n\r\n      // Prepend zeros to equalise exponents. Note: Faster to use reverse then do unshifts.\r\n      d.reverse();\r\n      for (; i--;) d.push(0);\r\n      d.reverse();\r\n    }\r\n\r\n    len = xd.length;\r\n    i = yd.length;\r\n\r\n    // If yd is longer than xd, swap xd and yd so xd points to the longer array.\r\n    if (len - i < 0) {\r\n      i = len;\r\n      d = yd;\r\n      yd = xd;\r\n      xd = d;\r\n    }\r\n\r\n    // Only start adding at yd.length - 1 as the further digits of xd can be left as they are.\r\n    for (carry = 0; i;) {\r\n      carry = (xd[--i] = xd[i] + yd[i] + carry) / BASE | 0;\r\n      xd[i] %= BASE;\r\n    }\r\n\r\n    if (carry) {\r\n      xd.unshift(carry);\r\n      ++e;\r\n    }\r\n\r\n    // Remove trailing zeros.\r\n    // No need to check for zero, as +x + +y != 0 && -x + -y != 0\r\n    for (len = xd.length; xd[--len] == 0;) xd.pop();\r\n\r\n    y.d = xd;\r\n    y.e = getBase10Exponent(xd, e);\r\n\r\n    return external ? finalise(y, pr, rm) : y;\r\n  };\r\n\r\n\r\n  /*\r\n   * Return the number of significant digits of the value of this Decimal.\r\n   *\r\n   * [z] {boolean|number} Whether to count integer-part trailing zeros: true, false, 1 or 0.\r\n   *\r\n   */\r\n  P.precision = P.sd = function (z) {\r\n    var k,\r\n      x = this;\r\n\r\n    if (z !== void 0 && z !== !!z && z !== 1 && z !== 0) throw Error(invalidArgument + z);\r\n\r\n    if (x.d) {\r\n      k = getPrecision(x.d);\r\n      if (z && x.e + 1 > k) k = x.e + 1;\r\n    } else {\r\n      k = NaN;\r\n    }\r\n\r\n    return k;\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the value of this Decimal rounded to a whole number using\r\n   * rounding mode `rounding`.\r\n   *\r\n   */\r\n  P.round = function () {\r\n    var x = this,\r\n      Ctor = x.constructor;\r\n\r\n    return finalise(new Ctor(x), x.e + 1, Ctor.rounding);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the sine of the value in radians of this Decimal.\r\n   *\r\n   * Domain: [-Infinity, Infinity]\r\n   * Range: [-1, 1]\r\n   *\r\n   * sin(x) = x - x^3/3! + x^5/5! - ...\r\n   *\r\n   * sin(0)         = 0\r\n   * sin(-0)        = -0\r\n   * sin(Infinity)  = NaN\r\n   * sin(-Infinity) = NaN\r\n   * sin(NaN)       = NaN\r\n   *\r\n   */\r\n  P.sine = P.sin = function () {\r\n    var pr, rm,\r\n      x = this,\r\n      Ctor = x.constructor;\r\n\r\n    if (!x.isFinite()) return new Ctor(NaN);\r\n    if (x.isZero()) return new Ctor(x);\r\n\r\n    pr = Ctor.precision;\r\n    rm = Ctor.rounding;\r\n    Ctor.precision = pr + Math.max(x.e, x.sd()) + LOG_BASE;\r\n    Ctor.rounding = 1;\r\n\r\n    x = sine(Ctor, toLessThanHalfPi(Ctor, x));\r\n\r\n    Ctor.precision = pr;\r\n    Ctor.rounding = rm;\r\n\r\n    return finalise(quadrant > 2 ? x.neg() : x, pr, rm, true);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the square root of this Decimal, rounded to `precision`\r\n   * significant digits using rounding mode `rounding`.\r\n   *\r\n   *  sqrt(-n) =  N\r\n   *  sqrt(N)  =  N\r\n   *  sqrt(-I) =  N\r\n   *  sqrt(I)  =  I\r\n   *  sqrt(0)  =  0\r\n   *  sqrt(-0) = -0\r\n   *\r\n   */\r\n  P.squareRoot = P.sqrt = function () {\r\n    var m, n, sd, r, rep, t,\r\n      x = this,\r\n      d = x.d,\r\n      e = x.e,\r\n      s = x.s,\r\n      Ctor = x.constructor;\r\n\r\n    // Negative/NaN/Infinity/zero?\r\n    if (s !== 1 || !d || !d[0]) {\r\n      return new Ctor(!s || s < 0 && (!d || d[0]) ? NaN : d ? x : 1 / 0);\r\n    }\r\n\r\n    external = false;\r\n\r\n    // Initial estimate.\r\n    s = Math.sqrt(+x);\r\n\r\n    // Math.sqrt underflow/overflow?\r\n    // Pass x to Math.sqrt as integer, then adjust the exponent of the result.\r\n    if (s == 0 || s == 1 / 0) {\r\n      n = digitsToString(d);\r\n\r\n      if ((n.length + e) % 2 == 0) n += '0';\r\n      s = Math.sqrt(n);\r\n      e = mathfloor((e + 1) / 2) - (e < 0 || e % 2);\r\n\r\n      if (s == 1 / 0) {\r\n        n = '5e' + e;\r\n      } else {\r\n        n = s.toExponential();\r\n        n = n.slice(0, n.indexOf('e') + 1) + e;\r\n      }\r\n\r\n      r = new Ctor(n);\r\n    } else {\r\n      r = new Ctor(s.toString());\r\n    }\r\n\r\n    sd = (e = Ctor.precision) + 3;\r\n\r\n    // Newton-Raphson iteration.\r\n    for (;;) {\r\n      t = r;\r\n      r = t.plus(divide(x, t, sd + 2, 1)).times(0.5);\r\n\r\n      // TODO? Replace with for-loop and checkRoundingDigits.\r\n      if (digitsToString(t.d).slice(0, sd) === (n = digitsToString(r.d)).slice(0, sd)) {\r\n        n = n.slice(sd - 3, sd + 1);\r\n\r\n        // The 4th rounding digit may be in error by -1 so if the 4 rounding digits are 9999 or\r\n        // 4999, i.e. approaching a rounding boundary, continue the iteration.\r\n        if (n == '9999' || !rep && n == '4999') {\r\n\r\n          // On the first iteration only, check to see if rounding up gives the exact result as the\r\n          // nines may infinitely repeat.\r\n          if (!rep) {\r\n            finalise(t, e + 1, 0);\r\n\r\n            if (t.times(t).eq(x)) {\r\n              r = t;\r\n              break;\r\n            }\r\n          }\r\n\r\n          sd += 4;\r\n          rep = 1;\r\n        } else {\r\n\r\n          // If the rounding digits are null, 0{0,4} or 50{0,3}, check for an exact result.\r\n          // If not, then there are further digits and m will be truthy.\r\n          if (!+n || !+n.slice(1) && n.charAt(0) == '5') {\r\n\r\n            // Truncate to the first rounding digit.\r\n            finalise(r, e + 1, 1);\r\n            m = !r.times(r).eq(x);\r\n          }\r\n\r\n          break;\r\n        }\r\n      }\r\n    }\r\n\r\n    external = true;\r\n\r\n    return finalise(r, e, Ctor.rounding, m);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the tangent of the value in radians of this Decimal.\r\n   *\r\n   * Domain: [-Infinity, Infinity]\r\n   * Range: [-Infinity, Infinity]\r\n   *\r\n   * tan(0)         = 0\r\n   * tan(-0)        = -0\r\n   * tan(Infinity)  = NaN\r\n   * tan(-Infinity) = NaN\r\n   * tan(NaN)       = NaN\r\n   *\r\n   */\r\n  P.tangent = P.tan = function () {\r\n    var pr, rm,\r\n      x = this,\r\n      Ctor = x.constructor;\r\n\r\n    if (!x.isFinite()) return new Ctor(NaN);\r\n    if (x.isZero()) return new Ctor(x);\r\n\r\n    pr = Ctor.precision;\r\n    rm = Ctor.rounding;\r\n    Ctor.precision = pr + 10;\r\n    Ctor.rounding = 1;\r\n\r\n    x = x.sin();\r\n    x.s = 1;\r\n    x = divide(x, new Ctor(1).minus(x.times(x)).sqrt(), pr + 10, 0);\r\n\r\n    Ctor.precision = pr;\r\n    Ctor.rounding = rm;\r\n\r\n    return finalise(quadrant == 2 || quadrant == 4 ? x.neg() : x, pr, rm, true);\r\n  };\r\n\r\n\r\n  /*\r\n   *  n * 0 = 0\r\n   *  n * N = N\r\n   *  n * I = I\r\n   *  0 * n = 0\r\n   *  0 * 0 = 0\r\n   *  0 * N = N\r\n   *  0 * I = N\r\n   *  N * n = N\r\n   *  N * 0 = N\r\n   *  N * N = N\r\n   *  N * I = N\r\n   *  I * n = I\r\n   *  I * 0 = N\r\n   *  I * N = N\r\n   *  I * I = I\r\n   *\r\n   * Return a new Decimal whose value is this Decimal times `y`, rounded to `precision` significant\r\n   * digits using rounding mode `rounding`.\r\n   *\r\n   */\r\n  P.times = P.mul = function (y) {\r\n    var carry, e, i, k, r, rL, t, xdL, ydL,\r\n      x = this,\r\n      Ctor = x.constructor,\r\n      xd = x.d,\r\n      yd = (y = new Ctor(y)).d;\r\n\r\n    y.s *= x.s;\r\n\r\n     // If either is NaN, ±Infinity or ±0...\r\n    if (!xd || !xd[0] || !yd || !yd[0]) {\r\n\r\n      return new Ctor(!y.s || xd && !xd[0] && !yd || yd && !yd[0] && !xd\r\n\r\n        // Return NaN if either is NaN.\r\n        // Return NaN if x is ±0 and y is ±Infinity, or y is ±0 and x is ±Infinity.\r\n        ? NaN\r\n\r\n        // Return ±Infinity if either is ±Infinity.\r\n        // Return ±0 if either is ±0.\r\n        : !xd || !yd ? y.s / 0 : y.s * 0);\r\n    }\r\n\r\n    e = mathfloor(x.e / LOG_BASE) + mathfloor(y.e / LOG_BASE);\r\n    xdL = xd.length;\r\n    ydL = yd.length;\r\n\r\n    // Ensure xd points to the longer array.\r\n    if (xdL < ydL) {\r\n      r = xd;\r\n      xd = yd;\r\n      yd = r;\r\n      rL = xdL;\r\n      xdL = ydL;\r\n      ydL = rL;\r\n    }\r\n\r\n    // Initialise the result array with zeros.\r\n    r = [];\r\n    rL = xdL + ydL;\r\n    for (i = rL; i--;) r.push(0);\r\n\r\n    // Multiply!\r\n    for (i = ydL; --i >= 0;) {\r\n      carry = 0;\r\n      for (k = xdL + i; k > i;) {\r\n        t = r[k] + yd[i] * xd[k - i - 1] + carry;\r\n        r[k--] = t % BASE | 0;\r\n        carry = t / BASE | 0;\r\n      }\r\n\r\n      r[k] = (r[k] + carry) % BASE | 0;\r\n    }\r\n\r\n    // Remove trailing zeros.\r\n    for (; !r[--rL];) r.pop();\r\n\r\n    if (carry) ++e;\r\n    else r.shift();\r\n\r\n    y.d = r;\r\n    y.e = getBase10Exponent(r, e);\r\n\r\n    return external ? finalise(y, Ctor.precision, Ctor.rounding) : y;\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a string representing the value of this Decimal in base 2, round to `sd` significant\r\n   * digits using rounding mode `rm`.\r\n   *\r\n   * If the optional `sd` argument is present then return binary exponential notation.\r\n   *\r\n   * [sd] {number} Significant digits. Integer, 1 to MAX_DIGITS inclusive.\r\n   * [rm] {number} Rounding mode. Integer, 0 to 8 inclusive.\r\n   *\r\n   */\r\n  P.toBinary = function (sd, rm) {\r\n    return toStringBinary(this, 2, sd, rm);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the value of this Decimal rounded to a maximum of `dp`\r\n   * decimal places using rounding mode `rm` or `rounding` if `rm` is omitted.\r\n   *\r\n   * If `dp` is omitted, return a new Decimal whose value is the value of this Decimal.\r\n   *\r\n   * [dp] {number} Decimal places. Integer, 0 to MAX_DIGITS inclusive.\r\n   * [rm] {number} Rounding mode. Integer, 0 to 8 inclusive.\r\n   *\r\n   */\r\n  P.toDecimalPlaces = P.toDP = function (dp, rm) {\r\n    var x = this,\r\n      Ctor = x.constructor;\r\n\r\n    x = new Ctor(x);\r\n    if (dp === void 0) return x;\r\n\r\n    checkInt32(dp, 0, MAX_DIGITS);\r\n\r\n    if (rm === void 0) rm = Ctor.rounding;\r\n    else checkInt32(rm, 0, 8);\r\n\r\n    return finalise(x, dp + x.e + 1, rm);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a string representing the value of this Decimal in exponential notation rounded to\r\n   * `dp` fixed decimal places using rounding mode `rounding`.\r\n   *\r\n   * [dp] {number} Decimal places. Integer, 0 to MAX_DIGITS inclusive.\r\n   * [rm] {number} Rounding mode. Integer, 0 to 8 inclusive.\r\n   *\r\n   */\r\n  P.toExponential = function (dp, rm) {\r\n    var str,\r\n      x = this,\r\n      Ctor = x.constructor;\r\n\r\n    if (dp === void 0) {\r\n      str = finiteToString(x, true);\r\n    } else {\r\n      checkInt32(dp, 0, MAX_DIGITS);\r\n\r\n      if (rm === void 0) rm = Ctor.rounding;\r\n      else checkInt32(rm, 0, 8);\r\n\r\n      x = finalise(new Ctor(x), dp + 1, rm);\r\n      str = finiteToString(x, true, dp + 1);\r\n    }\r\n\r\n    return x.isNeg() && !x.isZero() ? '-' + str : str;\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a string representing the value of this Decimal in normal (fixed-point) notation to\r\n   * `dp` fixed decimal places and rounded using rounding mode `rm` or `rounding` if `rm` is\r\n   * omitted.\r\n   *\r\n   * As with JavaScript numbers, (-0).toFixed(0) is '0', but e.g. (-0.00001).toFixed(0) is '-0'.\r\n   *\r\n   * [dp] {number} Decimal places. Integer, 0 to MAX_DIGITS inclusive.\r\n   * [rm] {number} Rounding mode. Integer, 0 to 8 inclusive.\r\n   *\r\n   * (-0).toFixed(0) is '0', but (-0.1).toFixed(0) is '-0'.\r\n   * (-0).toFixed(1) is '0.0', but (-0.01).toFixed(1) is '-0.0'.\r\n   * (-0).toFixed(3) is '0.000'.\r\n   * (-0.5).toFixed(0) is '-0'.\r\n   *\r\n   */\r\n  P.toFixed = function (dp, rm) {\r\n    var str, y,\r\n      x = this,\r\n      Ctor = x.constructor;\r\n\r\n    if (dp === void 0) {\r\n      str = finiteToString(x);\r\n    } else {\r\n      checkInt32(dp, 0, MAX_DIGITS);\r\n\r\n      if (rm === void 0) rm = Ctor.rounding;\r\n      else checkInt32(rm, 0, 8);\r\n\r\n      y = finalise(new Ctor(x), dp + x.e + 1, rm);\r\n      str = finiteToString(y, false, dp + y.e + 1);\r\n    }\r\n\r\n    // To determine whether to add the minus sign look at the value before it was rounded,\r\n    // i.e. look at `x` rather than `y`.\r\n    return x.isNeg() && !x.isZero() ? '-' + str : str;\r\n  };\r\n\r\n\r\n  /*\r\n   * Return an array representing the value of this Decimal as a simple fraction with an integer\r\n   * numerator and an integer denominator.\r\n   *\r\n   * The denominator will be a positive non-zero value less than or equal to the specified maximum\r\n   * denominator. If a maximum denominator is not specified, the denominator will be the lowest\r\n   * value necessary to represent the number exactly.\r\n   *\r\n   * [maxD] {number|string|bigint|Decimal} Maximum denominator. Integer >= 1 and < Infinity.\r\n   *\r\n   */\r\n  P.toFraction = function (maxD) {\r\n    var d, d0, d1, d2, e, k, n, n0, n1, pr, q, r,\r\n      x = this,\r\n      xd = x.d,\r\n      Ctor = x.constructor;\r\n\r\n    if (!xd) return new Ctor(x);\r\n\r\n    n1 = d0 = new Ctor(1);\r\n    d1 = n0 = new Ctor(0);\r\n\r\n    d = new Ctor(d1);\r\n    e = d.e = getPrecision(xd) - x.e - 1;\r\n    k = e % LOG_BASE;\r\n    d.d[0] = mathpow(10, k < 0 ? LOG_BASE + k : k);\r\n\r\n    if (maxD == null) {\r\n\r\n      // d is 10**e, the minimum max-denominator needed.\r\n      maxD = e > 0 ? d : n1;\r\n    } else {\r\n      n = new Ctor(maxD);\r\n      if (!n.isInt() || n.lt(n1)) throw Error(invalidArgument + n);\r\n      maxD = n.gt(d) ? (e > 0 ? d : n1) : n;\r\n    }\r\n\r\n    external = false;\r\n    n = new Ctor(digitsToString(xd));\r\n    pr = Ctor.precision;\r\n    Ctor.precision = e = xd.length * LOG_BASE * 2;\r\n\r\n    for (;;)  {\r\n      q = divide(n, d, 0, 1, 1);\r\n      d2 = d0.plus(q.times(d1));\r\n      if (d2.cmp(maxD) == 1) break;\r\n      d0 = d1;\r\n      d1 = d2;\r\n      d2 = n1;\r\n      n1 = n0.plus(q.times(d2));\r\n      n0 = d2;\r\n      d2 = d;\r\n      d = n.minus(q.times(d2));\r\n      n = d2;\r\n    }\r\n\r\n    d2 = divide(maxD.minus(d0), d1, 0, 1, 1);\r\n    n0 = n0.plus(d2.times(n1));\r\n    d0 = d0.plus(d2.times(d1));\r\n    n0.s = n1.s = x.s;\r\n\r\n    // Determine which fraction is closer to x, n0/d0 or n1/d1?\r\n    r = divide(n1, d1, e, 1).minus(x).abs().cmp(divide(n0, d0, e, 1).minus(x).abs()) < 1\r\n        ? [n1, d1] : [n0, d0];\r\n\r\n    Ctor.precision = pr;\r\n    external = true;\r\n\r\n    return r;\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a string representing the value of this Decimal in base 16, round to `sd` significant\r\n   * digits using rounding mode `rm`.\r\n   *\r\n   * If the optional `sd` argument is present then return binary exponential notation.\r\n   *\r\n   * [sd] {number} Significant digits. Integer, 1 to MAX_DIGITS inclusive.\r\n   * [rm] {number} Rounding mode. Integer, 0 to 8 inclusive.\r\n   *\r\n   */\r\n  P.toHexadecimal = P.toHex = function (sd, rm) {\r\n    return toStringBinary(this, 16, sd, rm);\r\n  };\r\n\r\n\r\n  /*\r\n   * Returns a new Decimal whose value is the nearest multiple of `y` in the direction of rounding\r\n   * mode `rm`, or `Decimal.rounding` if `rm` is omitted, to the value of this Decimal.\r\n   *\r\n   * The return value will always have the same sign as this Decimal, unless either this Decimal\r\n   * or `y` is NaN, in which case the return value will be also be NaN.\r\n   *\r\n   * The return value is not affected by the value of `precision`.\r\n   *\r\n   * y {number|string|bigint|Decimal} The magnitude to round to a multiple of.\r\n   * [rm] {number} Rounding mode. Integer, 0 to 8 inclusive.\r\n   *\r\n   * 'toNearest() rounding mode not an integer: {rm}'\r\n   * 'toNearest() rounding mode out of range: {rm}'\r\n   *\r\n   */\r\n  P.toNearest = function (y, rm) {\r\n    var x = this,\r\n      Ctor = x.constructor;\r\n\r\n    x = new Ctor(x);\r\n\r\n    if (y == null) {\r\n\r\n      // If x is not finite, return x.\r\n      if (!x.d) return x;\r\n\r\n      y = new Ctor(1);\r\n      rm = Ctor.rounding;\r\n    } else {\r\n      y = new Ctor(y);\r\n      if (rm === void 0) {\r\n        rm = Ctor.rounding;\r\n      } else {\r\n        checkInt32(rm, 0, 8);\r\n      }\r\n\r\n      // If x is not finite, return x if y is not NaN, else NaN.\r\n      if (!x.d) return y.s ? x : y;\r\n\r\n      // If y is not finite, return Infinity with the sign of x if y is Infinity, else NaN.\r\n      if (!y.d) {\r\n        if (y.s) y.s = x.s;\r\n        return y;\r\n      }\r\n    }\r\n\r\n    // If y is not zero, calculate the nearest multiple of y to x.\r\n    if (y.d[0]) {\r\n      external = false;\r\n      x = divide(x, y, 0, rm, 1).times(y);\r\n      external = true;\r\n      finalise(x);\r\n\r\n    // If y is zero, return zero with the sign of x.\r\n    } else {\r\n      y.s = x.s;\r\n      x = y;\r\n    }\r\n\r\n    return x;\r\n  };\r\n\r\n\r\n  /*\r\n   * Return the value of this Decimal converted to a number primitive.\r\n   * Zero keeps its sign.\r\n   *\r\n   */\r\n  P.toNumber = function () {\r\n    return +this;\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a string representing the value of this Decimal in base 8, round to `sd` significant\r\n   * digits using rounding mode `rm`.\r\n   *\r\n   * If the optional `sd` argument is present then return binary exponential notation.\r\n   *\r\n   * [sd] {number} Significant digits. Integer, 1 to MAX_DIGITS inclusive.\r\n   * [rm] {number} Rounding mode. Integer, 0 to 8 inclusive.\r\n   *\r\n   */\r\n  P.toOctal = function (sd, rm) {\r\n    return toStringBinary(this, 8, sd, rm);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the value of this Decimal raised to the power `y`, rounded\r\n   * to `precision` significant digits using rounding mode `rounding`.\r\n   *\r\n   * ECMAScript compliant.\r\n   *\r\n   *   pow(x, NaN)                           = NaN\r\n   *   pow(x, ±0)                            = 1\r\n\r\n   *   pow(NaN, non-zero)                    = NaN\r\n   *   pow(abs(x) > 1, +Infinity)            = +Infinity\r\n   *   pow(abs(x) > 1, -Infinity)            = +0\r\n   *   pow(abs(x) == 1, ±Infinity)           = NaN\r\n   *   pow(abs(x) < 1, +Infinity)            = +0\r\n   *   pow(abs(x) < 1, -Infinity)            = +Infinity\r\n   *   pow(+Infinity, y > 0)                 = +Infinity\r\n   *   pow(+Infinity, y < 0)                 = +0\r\n   *   pow(-Infinity, odd integer > 0)       = -Infinity\r\n   *   pow(-Infinity, even integer > 0)      = +Infinity\r\n   *   pow(-Infinity, odd integer < 0)       = -0\r\n   *   pow(-Infinity, even integer < 0)      = +0\r\n   *   pow(+0, y > 0)                        = +0\r\n   *   pow(+0, y < 0)                        = +Infinity\r\n   *   pow(-0, odd integer > 0)              = -0\r\n   *   pow(-0, even integer > 0)             = +0\r\n   *   pow(-0, odd integer < 0)              = -Infinity\r\n   *   pow(-0, even integer < 0)             = +Infinity\r\n   *   pow(finite x < 0, finite non-integer) = NaN\r\n   *\r\n   * For non-integer or very large exponents pow(x, y) is calculated using\r\n   *\r\n   *   x^y = exp(y*ln(x))\r\n   *\r\n   * Assuming the first 15 rounding digits are each equally likely to be any digit 0-9, the\r\n   * probability of an incorrectly rounded result\r\n   * P([49]9{14} | [50]0{14}) = 2 * 0.2 * 10^-14 = 4e-15 = 1/2.5e+14\r\n   * i.e. 1 in 250,000,000,000,000\r\n   *\r\n   * If a result is incorrectly rounded the maximum error will be 1 ulp (unit in last place).\r\n   *\r\n   * y {number|string|bigint|Decimal} The power to which to raise this Decimal.\r\n   *\r\n   */\r\n  P.toPower = P.pow = function (y) {\r\n    var e, k, pr, r, rm, s,\r\n      x = this,\r\n      Ctor = x.constructor,\r\n      yn = +(y = new Ctor(y));\r\n\r\n    // Either ±Infinity, NaN or ±0?\r\n    if (!x.d || !y.d || !x.d[0] || !y.d[0]) return new Ctor(mathpow(+x, yn));\r\n\r\n    x = new Ctor(x);\r\n\r\n    if (x.eq(1)) return x;\r\n\r\n    pr = Ctor.precision;\r\n    rm = Ctor.rounding;\r\n\r\n    if (y.eq(1)) return finalise(x, pr, rm);\r\n\r\n    // y exponent\r\n    e = mathfloor(y.e / LOG_BASE);\r\n\r\n    // If y is a small integer use the 'exponentiation by squaring' algorithm.\r\n    if (e >= y.d.length - 1 && (k = yn < 0 ? -yn : yn) <= MAX_SAFE_INTEGER) {\r\n      r = intPow(Ctor, x, k, pr);\r\n      return y.s < 0 ? new Ctor(1).div(r) : finalise(r, pr, rm);\r\n    }\r\n\r\n    s = x.s;\r\n\r\n    // if x is negative\r\n    if (s < 0) {\r\n\r\n      // if y is not an integer\r\n      if (e < y.d.length - 1) return new Ctor(NaN);\r\n\r\n      // Result is positive if x is negative and the last digit of integer y is even.\r\n      if ((y.d[e] & 1) == 0) s = 1;\r\n\r\n      // if x.eq(-1)\r\n      if (x.e == 0 && x.d[0] == 1 && x.d.length == 1) {\r\n        x.s = s;\r\n        return x;\r\n      }\r\n    }\r\n\r\n    // Estimate result exponent.\r\n    // x^y = 10^e,  where e = y * log10(x)\r\n    // log10(x) = log10(x_significand) + x_exponent\r\n    // log10(x_significand) = ln(x_significand) / ln(10)\r\n    k = mathpow(+x, yn);\r\n    e = k == 0 || !isFinite(k)\r\n      ? mathfloor(yn * (Math.log('0.' + digitsToString(x.d)) / Math.LN10 + x.e + 1))\r\n      : new Ctor(k + '').e;\r\n\r\n    // Exponent estimate may be incorrect e.g. x: 0.999999999999999999, y: 2.29, e: 0, r.e: -1.\r\n\r\n    // Overflow/underflow?\r\n    if (e > Ctor.maxE + 1 || e < Ctor.minE - 1) return new Ctor(e > 0 ? s / 0 : 0);\r\n\r\n    external = false;\r\n    Ctor.rounding = x.s = 1;\r\n\r\n    // Estimate the extra guard digits needed to ensure five correct rounding digits from\r\n    // naturalLogarithm(x). Example of failure without these extra digits (precision: 10):\r\n    // new Decimal(2.32456).pow('2087987436534566.46411')\r\n    // should be 1.162377823e+764914905173815, but is 1.162355823e+764914905173815\r\n    k = Math.min(12, (e + '').length);\r\n\r\n    // r = x^y = exp(y*ln(x))\r\n    r = naturalExponential(y.times(naturalLogarithm(x, pr + k)), pr);\r\n\r\n    // r may be Infinity, e.g. (0.9999999999999999).pow(-1e+40)\r\n    if (r.d) {\r\n\r\n      // Truncate to the required precision plus five rounding digits.\r\n      r = finalise(r, pr + 5, 1);\r\n\r\n      // If the rounding digits are [49]9999 or [50]0000 increase the precision by 10 and recalculate\r\n      // the result.\r\n      if (checkRoundingDigits(r.d, pr, rm)) {\r\n        e = pr + 10;\r\n\r\n        // Truncate to the increased precision plus five rounding digits.\r\n        r = finalise(naturalExponential(y.times(naturalLogarithm(x, e + k)), e), e + 5, 1);\r\n\r\n        // Check for 14 nines from the 2nd rounding digit (the first rounding digit may be 4 or 9).\r\n        if (+digitsToString(r.d).slice(pr + 1, pr + 15) + 1 == 1e14) {\r\n          r = finalise(r, pr + 1, 0);\r\n        }\r\n      }\r\n    }\r\n\r\n    r.s = s;\r\n    external = true;\r\n    Ctor.rounding = rm;\r\n\r\n    return finalise(r, pr, rm);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a string representing the value of this Decimal rounded to `sd` significant digits\r\n   * using rounding mode `rounding`.\r\n   *\r\n   * Return exponential notation if `sd` is less than the number of digits necessary to represent\r\n   * the integer part of the value in normal notation.\r\n   *\r\n   * [sd] {number} Significant digits. Integer, 1 to MAX_DIGITS inclusive.\r\n   * [rm] {number} Rounding mode. Integer, 0 to 8 inclusive.\r\n   *\r\n   */\r\n  P.toPrecision = function (sd, rm) {\r\n    var str,\r\n      x = this,\r\n      Ctor = x.constructor;\r\n\r\n    if (sd === void 0) {\r\n      str = finiteToString(x, x.e <= Ctor.toExpNeg || x.e >= Ctor.toExpPos);\r\n    } else {\r\n      checkInt32(sd, 1, MAX_DIGITS);\r\n\r\n      if (rm === void 0) rm = Ctor.rounding;\r\n      else checkInt32(rm, 0, 8);\r\n\r\n      x = finalise(new Ctor(x), sd, rm);\r\n      str = finiteToString(x, sd <= x.e || x.e <= Ctor.toExpNeg, sd);\r\n    }\r\n\r\n    return x.isNeg() && !x.isZero() ? '-' + str : str;\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the value of this Decimal rounded to a maximum of `sd`\r\n   * significant digits using rounding mode `rm`, or to `precision` and `rounding` respectively if\r\n   * omitted.\r\n   *\r\n   * [sd] {number} Significant digits. Integer, 1 to MAX_DIGITS inclusive.\r\n   * [rm] {number} Rounding mode. Integer, 0 to 8 inclusive.\r\n   *\r\n   * 'toSD() digits out of range: {sd}'\r\n   * 'toSD() digits not an integer: {sd}'\r\n   * 'toSD() rounding mode not an integer: {rm}'\r\n   * 'toSD() rounding mode out of range: {rm}'\r\n   *\r\n   */\r\n  P.toSignificantDigits = P.toSD = function (sd, rm) {\r\n    var x = this,\r\n      Ctor = x.constructor;\r\n\r\n    if (sd === void 0) {\r\n      sd = Ctor.precision;\r\n      rm = Ctor.rounding;\r\n    } else {\r\n      checkInt32(sd, 1, MAX_DIGITS);\r\n\r\n      if (rm === void 0) rm = Ctor.rounding;\r\n      else checkInt32(rm, 0, 8);\r\n    }\r\n\r\n    return finalise(new Ctor(x), sd, rm);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a string representing the value of this Decimal.\r\n   *\r\n   * Return exponential notation if this Decimal has a positive exponent equal to or greater than\r\n   * `toExpPos`, or a negative exponent equal to or less than `toExpNeg`.\r\n   *\r\n   */\r\n  P.toString = function () {\r\n    var x = this,\r\n      Ctor = x.constructor,\r\n      str = finiteToString(x, x.e <= Ctor.toExpNeg || x.e >= Ctor.toExpPos);\r\n\r\n    return x.isNeg() && !x.isZero() ? '-' + str : str;\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the value of this Decimal truncated to a whole number.\r\n   *\r\n   */\r\n  P.truncated = P.trunc = function () {\r\n    return finalise(new this.constructor(this), this.e + 1, 1);\r\n  };\r\n\r\n\r\n  /*\r\n   * Return a string representing the value of this Decimal.\r\n   * Unlike `toString`, negative zero will include the minus sign.\r\n   *\r\n   */\r\n  P.valueOf = P.toJSON = function () {\r\n    var x = this,\r\n      Ctor = x.constructor,\r\n      str = finiteToString(x, x.e <= Ctor.toExpNeg || x.e >= Ctor.toExpPos);\r\n\r\n    return x.isNeg() ? '-' + str : str;\r\n  };\r\n\r\n\r\n  // Helper functions for Decimal.prototype (P) and/or Decimal methods, and their callers.\r\n\r\n\r\n  /*\r\n   *  digitsToString           P.cubeRoot, P.logarithm, P.squareRoot, P.toFraction, P.toPower,\r\n   *                           finiteToString, naturalExponential, naturalLogarithm\r\n   *  checkInt32               P.toDecimalPlaces, P.toExponential, P.toFixed, P.toNearest,\r\n   *                           P.toPrecision, P.toSignificantDigits, toStringBinary, random\r\n   *  checkRoundingDigits      P.logarithm, P.toPower, naturalExponential, naturalLogarithm\r\n   *  convertBase              toStringBinary, parseOther\r\n   *  cos                      P.cos\r\n   *  divide                   P.atanh, P.cubeRoot, P.dividedBy, P.dividedToIntegerBy,\r\n   *                           P.logarithm, P.modulo, P.squareRoot, P.tan, P.tanh, P.toFraction,\r\n   *                           P.toNearest, toStringBinary, naturalExponential, naturalLogarithm,\r\n   *                           taylorSeries, atan2, parseOther\r\n   *  finalise                 P.absoluteValue, P.atan, P.atanh, P.ceil, P.cos, P.cosh,\r\n   *                           P.cubeRoot, P.dividedToIntegerBy, P.floor, P.logarithm, P.minus,\r\n   *                           P.modulo, P.negated, P.plus, P.round, P.sin, P.sinh, P.squareRoot,\r\n   *                           P.tan, P.times, P.toDecimalPlaces, P.toExponential, P.toFixed,\r\n   *                           P.toNearest, P.toPower, P.toPrecision, P.toSignificantDigits,\r\n   *                           P.truncated, divide, getLn10, getPi, naturalExponential,\r\n   *                           naturalLogarithm, ceil, floor, round, trunc\r\n   *  finiteToString           P.toExponential, P.toFixed, P.toPrecision, P.toString, P.valueOf,\r\n   *                           toStringBinary\r\n   *  getBase10Exponent        P.minus, P.plus, P.times, parseOther\r\n   *  getLn10                  P.logarithm, naturalLogarithm\r\n   *  getPi                    P.acos, P.asin, P.atan, toLessThanHalfPi, atan2\r\n   *  getPrecision             P.precision, P.toFraction\r\n   *  getZeroString            digitsToString, finiteToString\r\n   *  intPow                   P.toPower, parseOther\r\n   *  isOdd                    toLessThanHalfPi\r\n   *  maxOrMin                 max, min\r\n   *  naturalExponential       P.naturalExponential, P.toPower\r\n   *  naturalLogarithm         P.acosh, P.asinh, P.atanh, P.logarithm, P.naturalLogarithm,\r\n   *                           P.toPower, naturalExponential\r\n   *  nonFiniteToString        finiteToString, toStringBinary\r\n   *  parseDecimal             Decimal\r\n   *  parseOther               Decimal\r\n   *  sin                      P.sin\r\n   *  taylorSeries             P.cosh, P.sinh, cos, sin\r\n   *  toLessThanHalfPi         P.cos, P.sin\r\n   *  toStringBinary           P.toBinary, P.toHexadecimal, P.toOctal\r\n   *  truncate                 intPow\r\n   *\r\n   *  Throws:                  P.logarithm, P.precision, P.toFraction, checkInt32, getLn10, getPi,\r\n   *                           naturalLogarithm, config, parseOther, random, Decimal\r\n   */\r\n\r\n\r\n  function digitsToString(d) {\r\n    var i, k, ws,\r\n      indexOfLastWord = d.length - 1,\r\n      str = '',\r\n      w = d[0];\r\n\r\n    if (indexOfLastWord > 0) {\r\n      str += w;\r\n      for (i = 1; i < indexOfLastWord; i++) {\r\n        ws = d[i] + '';\r\n        k = LOG_BASE - ws.length;\r\n        if (k) str += getZeroString(k);\r\n        str += ws;\r\n      }\r\n\r\n      w = d[i];\r\n      ws = w + '';\r\n      k = LOG_BASE - ws.length;\r\n      if (k) str += getZeroString(k);\r\n    } else if (w === 0) {\r\n      return '0';\r\n    }\r\n\r\n    // Remove trailing zeros of last w.\r\n    for (; w % 10 === 0;) w /= 10;\r\n\r\n    return str + w;\r\n  }\r\n\r\n\r\n  function checkInt32(i, min, max) {\r\n    if (i !== ~~i || i < min || i > max) {\r\n      throw Error(invalidArgument + i);\r\n    }\r\n  }\r\n\r\n\r\n  /*\r\n   * Check 5 rounding digits if `repeating` is null, 4 otherwise.\r\n   * `repeating == null` if caller is `log` or `pow`,\r\n   * `repeating != null` if caller is `naturalLogarithm` or `naturalExponential`.\r\n   */\r\n  function checkRoundingDigits(d, i, rm, repeating) {\r\n    var di, k, r, rd;\r\n\r\n    // Get the length of the first word of the array d.\r\n    for (k = d[0]; k >= 10; k /= 10) --i;\r\n\r\n    // Is the rounding digit in the first word of d?\r\n    if (--i < 0) {\r\n      i += LOG_BASE;\r\n      di = 0;\r\n    } else {\r\n      di = Math.ceil((i + 1) / LOG_BASE);\r\n      i %= LOG_BASE;\r\n    }\r\n\r\n    // i is the index (0 - 6) of the rounding digit.\r\n    // E.g. if within the word 3487563 the first rounding digit is 5,\r\n    // then i = 4, k = 1000, rd = 3487563 % 1000 = 563\r\n    k = mathpow(10, LOG_BASE - i);\r\n    rd = d[di] % k | 0;\r\n\r\n    if (repeating == null) {\r\n      if (i < 3) {\r\n        if (i == 0) rd = rd / 100 | 0;\r\n        else if (i == 1) rd = rd / 10 | 0;\r\n        r = rm < 4 && rd == 99999 || rm > 3 && rd == 49999 || rd == 50000 || rd == 0;\r\n      } else {\r\n        r = (rm < 4 && rd + 1 == k || rm > 3 && rd + 1 == k / 2) &&\r\n          (d[di + 1] / k / 100 | 0) == mathpow(10, i - 2) - 1 ||\r\n            (rd == k / 2 || rd == 0) && (d[di + 1] / k / 100 | 0) == 0;\r\n      }\r\n    } else {\r\n      if (i < 4) {\r\n        if (i == 0) rd = rd / 1000 | 0;\r\n        else if (i == 1) rd = rd / 100 | 0;\r\n        else if (i == 2) rd = rd / 10 | 0;\r\n        r = (repeating || rm < 4) && rd == 9999 || !repeating && rm > 3 && rd == 4999;\r\n      } else {\r\n        r = ((repeating || rm < 4) && rd + 1 == k ||\r\n        (!repeating && rm > 3) && rd + 1 == k / 2) &&\r\n          (d[di + 1] / k / 1000 | 0) == mathpow(10, i - 3) - 1;\r\n      }\r\n    }\r\n\r\n    return r;\r\n  }\r\n\r\n\r\n  // Convert string of `baseIn` to an array of numbers of `baseOut`.\r\n  // Eg. convertBase('255', 10, 16) returns [15, 15].\r\n  // Eg. convertBase('ff', 16, 10) returns [2, 5, 5].\r\n  function convertBase(str, baseIn, baseOut) {\r\n    var j,\r\n      arr = [0],\r\n      arrL,\r\n      i = 0,\r\n      strL = str.length;\r\n\r\n    for (; i < strL;) {\r\n      for (arrL = arr.length; arrL--;) arr[arrL] *= baseIn;\r\n      arr[0] += NUMERALS.indexOf(str.charAt(i++));\r\n      for (j = 0; j < arr.length; j++) {\r\n        if (arr[j] > baseOut - 1) {\r\n          if (arr[j + 1] === void 0) arr[j + 1] = 0;\r\n          arr[j + 1] += arr[j] / baseOut | 0;\r\n          arr[j] %= baseOut;\r\n        }\r\n      }\r\n    }\r\n\r\n    return arr.reverse();\r\n  }\r\n\r\n\r\n  /*\r\n   * cos(x) = 1 - x^2/2! + x^4/4! - ...\r\n   * |x| < pi/2\r\n   *\r\n   */\r\n  function cosine(Ctor, x) {\r\n    var k, len, y;\r\n\r\n    if (x.isZero()) return x;\r\n\r\n    // Argument reduction: cos(4x) = 8*(cos^4(x) - cos^2(x)) + 1\r\n    // i.e. cos(x) = 8*(cos^4(x/4) - cos^2(x/4)) + 1\r\n\r\n    // Estimate the optimum number of times to use the argument reduction.\r\n    len = x.d.length;\r\n    if (len < 32) {\r\n      k = Math.ceil(len / 3);\r\n      y = (1 / tinyPow(4, k)).toString();\r\n    } else {\r\n      k = 16;\r\n      y = '2.3283064365386962890625e-10';\r\n    }\r\n\r\n    Ctor.precision += k;\r\n\r\n    x = taylorSeries(Ctor, 1, x.times(y), new Ctor(1));\r\n\r\n    // Reverse argument reduction\r\n    for (var i = k; i--;) {\r\n      var cos2x = x.times(x);\r\n      x = cos2x.times(cos2x).minus(cos2x).times(8).plus(1);\r\n    }\r\n\r\n    Ctor.precision -= k;\r\n\r\n    return x;\r\n  }\r\n\r\n\r\n  /*\r\n   * Perform division in the specified base.\r\n   */\r\n  var divide = (function () {\r\n\r\n    // Assumes non-zero x and k, and hence non-zero result.\r\n    function multiplyInteger(x, k, base) {\r\n      var temp,\r\n        carry = 0,\r\n        i = x.length;\r\n\r\n      for (x = x.slice(); i--;) {\r\n        temp = x[i] * k + carry;\r\n        x[i] = temp % base | 0;\r\n        carry = temp / base | 0;\r\n      }\r\n\r\n      if (carry) x.unshift(carry);\r\n\r\n      return x;\r\n    }\r\n\r\n    function compare(a, b, aL, bL) {\r\n      var i, r;\r\n\r\n      if (aL != bL) {\r\n        r = aL > bL ? 1 : -1;\r\n      } else {\r\n        for (i = r = 0; i < aL; i++) {\r\n          if (a[i] != b[i]) {\r\n            r = a[i] > b[i] ? 1 : -1;\r\n            break;\r\n          }\r\n        }\r\n      }\r\n\r\n      return r;\r\n    }\r\n\r\n    function subtract(a, b, aL, base) {\r\n      var i = 0;\r\n\r\n      // Subtract b from a.\r\n      for (; aL--;) {\r\n        a[aL] -= i;\r\n        i = a[aL] < b[aL] ? 1 : 0;\r\n        a[aL] = i * base + a[aL] - b[aL];\r\n      }\r\n\r\n      // Remove leading zeros.\r\n      for (; !a[0] && a.length > 1;) a.shift();\r\n    }\r\n\r\n    return function (x, y, pr, rm, dp, base) {\r\n      var cmp, e, i, k, logBase, more, prod, prodL, q, qd, rem, remL, rem0, sd, t, xi, xL, yd0,\r\n        yL, yz,\r\n        Ctor = x.constructor,\r\n        sign = x.s == y.s ? 1 : -1,\r\n        xd = x.d,\r\n        yd = y.d;\r\n\r\n      // Either NaN, Infinity or 0?\r\n      if (!xd || !xd[0] || !yd || !yd[0]) {\r\n\r\n        return new Ctor(// Return NaN if either NaN, or both Infinity or 0.\r\n          !x.s || !y.s || (xd ? yd && xd[0] == yd[0] : !yd) ? NaN :\r\n\r\n          // Return ±0 if x is 0 or y is ±Infinity, or return ±Infinity as y is 0.\r\n          xd && xd[0] == 0 || !yd ? sign * 0 : sign / 0);\r\n      }\r\n\r\n      if (base) {\r\n        logBase = 1;\r\n        e = x.e - y.e;\r\n      } else {\r\n        base = BASE;\r\n        logBase = LOG_BASE;\r\n        e = mathfloor(x.e / logBase) - mathfloor(y.e / logBase);\r\n      }\r\n\r\n      yL = yd.length;\r\n      xL = xd.length;\r\n      q = new Ctor(sign);\r\n      qd = q.d = [];\r\n\r\n      // Result exponent may be one less than e.\r\n      // The digit array of a Decimal from toStringBinary may have trailing zeros.\r\n      for (i = 0; yd[i] == (xd[i] || 0); i++);\r\n\r\n      if (yd[i] > (xd[i] || 0)) e--;\r\n\r\n      if (pr == null) {\r\n        sd = pr = Ctor.precision;\r\n        rm = Ctor.rounding;\r\n      } else if (dp) {\r\n        sd = pr + (x.e - y.e) + 1;\r\n      } else {\r\n        sd = pr;\r\n      }\r\n\r\n      if (sd < 0) {\r\n        qd.push(1);\r\n        more = true;\r\n      } else {\r\n\r\n        // Convert precision in number of base 10 digits to base 1e7 digits.\r\n        sd = sd / logBase + 2 | 0;\r\n        i = 0;\r\n\r\n        // divisor < 1e7\r\n        if (yL == 1) {\r\n          k = 0;\r\n          yd = yd[0];\r\n          sd++;\r\n\r\n          // k is the carry.\r\n          for (; (i < xL || k) && sd--; i++) {\r\n            t = k * base + (xd[i] || 0);\r\n            qd[i] = t / yd | 0;\r\n            k = t % yd | 0;\r\n          }\r\n\r\n          more = k || i < xL;\r\n\r\n        // divisor >= 1e7\r\n        } else {\r\n\r\n          // Normalise xd and yd so highest order digit of yd is >= base/2\r\n          k = base / (yd[0] + 1) | 0;\r\n\r\n          if (k > 1) {\r\n            yd = multiplyInteger(yd, k, base);\r\n            xd = multiplyInteger(xd, k, base);\r\n            yL = yd.length;\r\n            xL = xd.length;\r\n          }\r\n\r\n          xi = yL;\r\n          rem = xd.slice(0, yL);\r\n          remL = rem.length;\r\n\r\n          // Add zeros to make remainder as long as divisor.\r\n          for (; remL < yL;) rem[remL++] = 0;\r\n\r\n          yz = yd.slice();\r\n          yz.unshift(0);\r\n          yd0 = yd[0];\r\n\r\n          if (yd[1] >= base / 2) ++yd0;\r\n\r\n          do {\r\n            k = 0;\r\n\r\n            // Compare divisor and remainder.\r\n            cmp = compare(yd, rem, yL, remL);\r\n\r\n            // If divisor < remainder.\r\n            if (cmp < 0) {\r\n\r\n              // Calculate trial digit, k.\r\n              rem0 = rem[0];\r\n              if (yL != remL) rem0 = rem0 * base + (rem[1] || 0);\r\n\r\n              // k will be how many times the divisor goes into the current remainder.\r\n              k = rem0 / yd0 | 0;\r\n\r\n              //  Algorithm:\r\n              //  1. product = divisor * trial digit (k)\r\n              //  2. if product > remainder: product -= divisor, k--\r\n              //  3. remainder -= product\r\n              //  4. if product was < remainder at 2:\r\n              //    5. compare new remainder and divisor\r\n              //    6. If remainder > divisor: remainder -= divisor, k++\r\n\r\n              if (k > 1) {\r\n                if (k >= base) k = base - 1;\r\n\r\n                // product = divisor * trial digit.\r\n                prod = multiplyInteger(yd, k, base);\r\n                prodL = prod.length;\r\n                remL = rem.length;\r\n\r\n                // Compare product and remainder.\r\n                cmp = compare(prod, rem, prodL, remL);\r\n\r\n                // product > remainder.\r\n                if (cmp == 1) {\r\n                  k--;\r\n\r\n                  // Subtract divisor from product.\r\n                  subtract(prod, yL < prodL ? yz : yd, prodL, base);\r\n                }\r\n              } else {\r\n\r\n                // cmp is -1.\r\n                // If k is 0, there is no need to compare yd and rem again below, so change cmp to 1\r\n                // to avoid it. If k is 1 there is a need to compare yd and rem again below.\r\n                if (k == 0) cmp = k = 1;\r\n                prod = yd.slice();\r\n              }\r\n\r\n              prodL = prod.length;\r\n              if (prodL < remL) prod.unshift(0);\r\n\r\n              // Subtract product from remainder.\r\n              subtract(rem, prod, remL, base);\r\n\r\n              // If product was < previous remainder.\r\n              if (cmp == -1) {\r\n                remL = rem.length;\r\n\r\n                // Compare divisor and new remainder.\r\n                cmp = compare(yd, rem, yL, remL);\r\n\r\n                // If divisor < new remainder, subtract divisor from remainder.\r\n                if (cmp < 1) {\r\n                  k++;\r\n\r\n                  // Subtract divisor from remainder.\r\n                  subtract(rem, yL < remL ? yz : yd, remL, base);\r\n                }\r\n              }\r\n\r\n              remL = rem.length;\r\n            } else if (cmp === 0) {\r\n              k++;\r\n              rem = [0];\r\n            }    // if cmp === 1, k will be 0\r\n\r\n            // Add the next digit, k, to the result array.\r\n            qd[i++] = k;\r\n\r\n            // Update the remainder.\r\n            if (cmp && rem[0]) {\r\n              rem[remL++] = xd[xi] || 0;\r\n            } else {\r\n              rem = [xd[xi]];\r\n              remL = 1;\r\n            }\r\n\r\n          } while ((xi++ < xL || rem[0] !== void 0) && sd--);\r\n\r\n          more = rem[0] !== void 0;\r\n        }\r\n\r\n        // Leading zero?\r\n        if (!qd[0]) qd.shift();\r\n      }\r\n\r\n      // logBase is 1 when divide is being used for base conversion.\r\n      if (logBase == 1) {\r\n        q.e = e;\r\n        inexact = more;\r\n      } else {\r\n\r\n        // To calculate q.e, first get the number of digits of qd[0].\r\n        for (i = 1, k = qd[0]; k >= 10; k /= 10) i++;\r\n        q.e = i + e * logBase - 1;\r\n\r\n        finalise(q, dp ? pr + q.e + 1 : pr, rm, more);\r\n      }\r\n\r\n      return q;\r\n    };\r\n  })();\r\n\r\n\r\n  /*\r\n   * Round `x` to `sd` significant digits using rounding mode `rm`.\r\n   * Check for over/under-flow.\r\n   */\r\n   function finalise(x, sd, rm, isTruncated) {\r\n    var digits, i, j, k, rd, roundUp, w, xd, xdi,\r\n      Ctor = x.constructor;\r\n\r\n    // Don't round if sd is null or undefined.\r\n    out: if (sd != null) {\r\n      xd = x.d;\r\n\r\n      // Infinity/NaN.\r\n      if (!xd) return x;\r\n\r\n      // rd: the rounding digit, i.e. the digit after the digit that may be rounded up.\r\n      // w: the word of xd containing rd, a base 1e7 number.\r\n      // xdi: the index of w within xd.\r\n      // digits: the number of digits of w.\r\n      // i: what would be the index of rd within w if all the numbers were 7 digits long (i.e. if\r\n      // they had leading zeros)\r\n      // j: if > 0, the actual index of rd within w (if < 0, rd is a leading zero).\r\n\r\n      // Get the length of the first word of the digits array xd.\r\n      for (digits = 1, k = xd[0]; k >= 10; k /= 10) digits++;\r\n      i = sd - digits;\r\n\r\n      // Is the rounding digit in the first word of xd?\r\n      if (i < 0) {\r\n        i += LOG_BASE;\r\n        j = sd;\r\n        w = xd[xdi = 0];\r\n\r\n        // Get the rounding digit at index j of w.\r\n        rd = w / mathpow(10, digits - j - 1) % 10 | 0;\r\n      } else {\r\n        xdi = Math.ceil((i + 1) / LOG_BASE);\r\n        k = xd.length;\r\n        if (xdi >= k) {\r\n          if (isTruncated) {\r\n\r\n            // Needed by `naturalExponential`, `naturalLogarithm` and `squareRoot`.\r\n            for (; k++ <= xdi;) xd.push(0);\r\n            w = rd = 0;\r\n            digits = 1;\r\n            i %= LOG_BASE;\r\n            j = i - LOG_BASE + 1;\r\n          } else {\r\n            break out;\r\n          }\r\n        } else {\r\n          w = k = xd[xdi];\r\n\r\n          // Get the number of digits of w.\r\n          for (digits = 1; k >= 10; k /= 10) digits++;\r\n\r\n          // Get the index of rd within w.\r\n          i %= LOG_BASE;\r\n\r\n          // Get the index of rd within w, adjusted for leading zeros.\r\n          // The number of leading zeros of w is given by LOG_BASE - digits.\r\n          j = i - LOG_BASE + digits;\r\n\r\n          // Get the rounding digit at index j of w.\r\n          rd = j < 0 ? 0 : w / mathpow(10, digits - j - 1) % 10 | 0;\r\n        }\r\n      }\r\n\r\n      // Are there any non-zero digits after the rounding digit?\r\n      isTruncated = isTruncated || sd < 0 ||\r\n        xd[xdi + 1] !== void 0 || (j < 0 ? w : w % mathpow(10, digits - j - 1));\r\n\r\n      // The expression `w % mathpow(10, digits - j - 1)` returns all the digits of w to the right\r\n      // of the digit at (left-to-right) index j, e.g. if w is 908714 and j is 2, the expression\r\n      // will give 714.\r\n\r\n      roundUp = rm < 4\r\n        ? (rd || isTruncated) && (rm == 0 || rm == (x.s < 0 ? 3 : 2))\r\n        : rd > 5 || rd == 5 && (rm == 4 || isTruncated || rm == 6 &&\r\n\r\n          // Check whether the digit to the left of the rounding digit is odd.\r\n          ((i > 0 ? j > 0 ? w / mathpow(10, digits - j) : 0 : xd[xdi - 1]) % 10) & 1 ||\r\n            rm == (x.s < 0 ? 8 : 7));\r\n\r\n      if (sd < 1 || !xd[0]) {\r\n        xd.length = 0;\r\n        if (roundUp) {\r\n\r\n          // Convert sd to decimal places.\r\n          sd -= x.e + 1;\r\n\r\n          // 1, 0.1, 0.01, 0.001, 0.0001 etc.\r\n          xd[0] = mathpow(10, (LOG_BASE - sd % LOG_BASE) % LOG_BASE);\r\n          x.e = -sd || 0;\r\n        } else {\r\n\r\n          // Zero.\r\n          xd[0] = x.e = 0;\r\n        }\r\n\r\n        return x;\r\n      }\r\n\r\n      // Remove excess digits.\r\n      if (i == 0) {\r\n        xd.length = xdi;\r\n        k = 1;\r\n        xdi--;\r\n      } else {\r\n        xd.length = xdi + 1;\r\n        k = mathpow(10, LOG_BASE - i);\r\n\r\n        // E.g. 56700 becomes 56000 if 7 is the rounding digit.\r\n        // j > 0 means i > number of leading zeros of w.\r\n        xd[xdi] = j > 0 ? (w / mathpow(10, digits - j) % mathpow(10, j) | 0) * k : 0;\r\n      }\r\n\r\n      if (roundUp) {\r\n        for (;;) {\r\n\r\n          // Is the digit to be rounded up in the first word of xd?\r\n          if (xdi == 0) {\r\n\r\n            // i will be the length of xd[0] before k is added.\r\n            for (i = 1, j = xd[0]; j >= 10; j /= 10) i++;\r\n            j = xd[0] += k;\r\n            for (k = 1; j >= 10; j /= 10) k++;\r\n\r\n            // if i != k the length has increased.\r\n            if (i != k) {\r\n              x.e++;\r\n              if (xd[0] == BASE) xd[0] = 1;\r\n            }\r\n\r\n            break;\r\n          } else {\r\n            xd[xdi] += k;\r\n            if (xd[xdi] != BASE) break;\r\n            xd[xdi--] = 0;\r\n            k = 1;\r\n          }\r\n        }\r\n      }\r\n\r\n      // Remove trailing zeros.\r\n      for (i = xd.length; xd[--i] === 0;) xd.pop();\r\n    }\r\n\r\n    if (external) {\r\n\r\n      // Overflow?\r\n      if (x.e > Ctor.maxE) {\r\n\r\n        // Infinity.\r\n        x.d = null;\r\n        x.e = NaN;\r\n\r\n      // Underflow?\r\n      } else if (x.e < Ctor.minE) {\r\n\r\n        // Zero.\r\n        x.e = 0;\r\n        x.d = [0];\r\n        // Ctor.underflow = true;\r\n      } // else Ctor.underflow = false;\r\n    }\r\n\r\n    return x;\r\n  }\r\n\r\n\r\n  function finiteToString(x, isExp, sd) {\r\n    if (!x.isFinite()) return nonFiniteToString(x);\r\n    var k,\r\n      e = x.e,\r\n      str = digitsToString(x.d),\r\n      len = str.length;\r\n\r\n    if (isExp) {\r\n      if (sd && (k = sd - len) > 0) {\r\n        str = str.charAt(0) + '.' + str.slice(1) + getZeroString(k);\r\n      } else if (len > 1) {\r\n        str = str.charAt(0) + '.' + str.slice(1);\r\n      }\r\n\r\n      str = str + (x.e < 0 ? 'e' : 'e+') + x.e;\r\n    } else if (e < 0) {\r\n      str = '0.' + getZeroString(-e - 1) + str;\r\n      if (sd && (k = sd - len) > 0) str += getZeroString(k);\r\n    } else if (e >= len) {\r\n      str += getZeroString(e + 1 - len);\r\n      if (sd && (k = sd - e - 1) > 0) str = str + '.' + getZeroString(k);\r\n    } else {\r\n      if ((k = e + 1) < len) str = str.slice(0, k) + '.' + str.slice(k);\r\n      if (sd && (k = sd - len) > 0) {\r\n        if (e + 1 === len) str += '.';\r\n        str += getZeroString(k);\r\n      }\r\n    }\r\n\r\n    return str;\r\n  }\r\n\r\n\r\n  // Calculate the base 10 exponent from the base 1e7 exponent.\r\n  function getBase10Exponent(digits, e) {\r\n    var w = digits[0];\r\n\r\n    // Add the number of digits of the first word of the digits array.\r\n    for ( e *= LOG_BASE; w >= 10; w /= 10) e++;\r\n    return e;\r\n  }\r\n\r\n\r\n  function getLn10(Ctor, sd, pr) {\r\n    if (sd > LN10_PRECISION) {\r\n\r\n      // Reset global state in case the exception is caught.\r\n      external = true;\r\n      if (pr) Ctor.precision = pr;\r\n      throw Error(precisionLimitExceeded);\r\n    }\r\n    return finalise(new Ctor(LN10), sd, 1, true);\r\n  }\r\n\r\n\r\n  function getPi(Ctor, sd, rm) {\r\n    if (sd > PI_PRECISION) throw Error(precisionLimitExceeded);\r\n    return finalise(new Ctor(PI), sd, rm, true);\r\n  }\r\n\r\n\r\n  function getPrecision(digits) {\r\n    var w = digits.length - 1,\r\n      len = w * LOG_BASE + 1;\r\n\r\n    w = digits[w];\r\n\r\n    // If non-zero...\r\n    if (w) {\r\n\r\n      // Subtract the number of trailing zeros of the last word.\r\n      for (; w % 10 == 0; w /= 10) len--;\r\n\r\n      // Add the number of digits of the first word.\r\n      for (w = digits[0]; w >= 10; w /= 10) len++;\r\n    }\r\n\r\n    return len;\r\n  }\r\n\r\n\r\n  function getZeroString(k) {\r\n    var zs = '';\r\n    for (; k--;) zs += '0';\r\n    return zs;\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the value of Decimal `x` to the power `n`, where `n` is an\r\n   * integer of type number.\r\n   *\r\n   * Implements 'exponentiation by squaring'. Called by `pow` and `parseOther`.\r\n   *\r\n   */\r\n  function intPow(Ctor, x, n, pr) {\r\n    var isTruncated,\r\n      r = new Ctor(1),\r\n\r\n      // Max n of 9007199254740991 takes 53 loop iterations.\r\n      // Maximum digits array length; leaves [28, 34] guard digits.\r\n      k = Math.ceil(pr / LOG_BASE + 4);\r\n\r\n    external = false;\r\n\r\n    for (;;) {\r\n      if (n % 2) {\r\n        r = r.times(x);\r\n        if (truncate(r.d, k)) isTruncated = true;\r\n      }\r\n\r\n      n = mathfloor(n / 2);\r\n      if (n === 0) {\r\n\r\n        // To ensure correct rounding when r.d is truncated, increment the last word if it is zero.\r\n        n = r.d.length - 1;\r\n        if (isTruncated && r.d[n] === 0) ++r.d[n];\r\n        break;\r\n      }\r\n\r\n      x = x.times(x);\r\n      truncate(x.d, k);\r\n    }\r\n\r\n    external = true;\r\n\r\n    return r;\r\n  }\r\n\r\n\r\n  function isOdd(n) {\r\n    return n.d[n.d.length - 1] & 1;\r\n  }\r\n\r\n\r\n  /*\r\n   * Handle `max` (`n` is -1) and `min` (`n` is 1).\r\n   */\r\n  function maxOrMin(Ctor, args, n) {\r\n    var k, y,\r\n      x = new Ctor(args[0]),\r\n      i = 0;\r\n\r\n    for (; ++i < args.length;) {\r\n      y = new Ctor(args[i]);\r\n\r\n      // NaN?\r\n      if (!y.s) {\r\n        x = y;\r\n        break;\r\n      }\r\n\r\n      k = x.cmp(y);\r\n\r\n      if (k === n || k === 0 && x.s === n) {\r\n        x = y;\r\n      }\r\n    }\r\n\r\n    return x;\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the natural exponential of `x` rounded to `sd` significant\r\n   * digits.\r\n   *\r\n   * Taylor/Maclaurin series.\r\n   *\r\n   * exp(x) = x^0/0! + x^1/1! + x^2/2! + x^3/3! + ...\r\n   *\r\n   * Argument reduction:\r\n   *   Repeat x = x / 32, k += 5, until |x| < 0.1\r\n   *   exp(x) = exp(x / 2^k)^(2^k)\r\n   *\r\n   * Previously, the argument was initially reduced by\r\n   * exp(x) = exp(r) * 10^k  where r = x - k * ln10, k = floor(x / ln10)\r\n   * to first put r in the range [0, ln10], before dividing by 32 until |x| < 0.1, but this was\r\n   * found to be slower than just dividing repeatedly by 32 as above.\r\n   *\r\n   * Max integer argument: exp('20723265836946413') = 6.3e+9000000000000000\r\n   * Min integer argument: exp('-20723265836946411') = 1.2e-9000000000000000\r\n   * (Math object integer min/max: Math.exp(709) = 8.2e+307, Math.exp(-745) = 5e-324)\r\n   *\r\n   *  exp(Infinity)  = Infinity\r\n   *  exp(-Infinity) = 0\r\n   *  exp(NaN)       = NaN\r\n   *  exp(±0)        = 1\r\n   *\r\n   *  exp(x) is non-terminating for any finite, non-zero x.\r\n   *\r\n   *  The result will always be correctly rounded.\r\n   *\r\n   */\r\n  function naturalExponential(x, sd) {\r\n    var denominator, guard, j, pow, sum, t, wpr,\r\n      rep = 0,\r\n      i = 0,\r\n      k = 0,\r\n      Ctor = x.constructor,\r\n      rm = Ctor.rounding,\r\n      pr = Ctor.precision;\r\n\r\n    // 0/NaN/Infinity?\r\n    if (!x.d || !x.d[0] || x.e > 17) {\r\n\r\n      return new Ctor(x.d\r\n        ? !x.d[0] ? 1 : x.s < 0 ? 0 : 1 / 0\r\n        : x.s ? x.s < 0 ? 0 : x : 0 / 0);\r\n    }\r\n\r\n    if (sd == null) {\r\n      external = false;\r\n      wpr = pr;\r\n    } else {\r\n      wpr = sd;\r\n    }\r\n\r\n    t = new Ctor(0.03125);\r\n\r\n    // while abs(x) >= 0.1\r\n    while (x.e > -2) {\r\n\r\n      // x = x / 2^5\r\n      x = x.times(t);\r\n      k += 5;\r\n    }\r\n\r\n    // Use 2 * log10(2^k) + 5 (empirically derived) to estimate the increase in precision\r\n    // necessary to ensure the first 4 rounding digits are correct.\r\n    guard = Math.log(mathpow(2, k)) / Math.LN10 * 2 + 5 | 0;\r\n    wpr += guard;\r\n    denominator = pow = sum = new Ctor(1);\r\n    Ctor.precision = wpr;\r\n\r\n    for (;;) {\r\n      pow = finalise(pow.times(x), wpr, 1);\r\n      denominator = denominator.times(++i);\r\n      t = sum.plus(divide(pow, denominator, wpr, 1));\r\n\r\n      if (digitsToString(t.d).slice(0, wpr) === digitsToString(sum.d).slice(0, wpr)) {\r\n        j = k;\r\n        while (j--) sum = finalise(sum.times(sum), wpr, 1);\r\n\r\n        // Check to see if the first 4 rounding digits are [49]999.\r\n        // If so, repeat the summation with a higher precision, otherwise\r\n        // e.g. with precision: 18, rounding: 1\r\n        // exp(18.404272462595034083567793919843761) = 98372560.1229999999 (should be 98372560.123)\r\n        // `wpr - guard` is the index of first rounding digit.\r\n        if (sd == null) {\r\n\r\n          if (rep < 3 && checkRoundingDigits(sum.d, wpr - guard, rm, rep)) {\r\n            Ctor.precision = wpr += 10;\r\n            denominator = pow = t = new Ctor(1);\r\n            i = 0;\r\n            rep++;\r\n          } else {\r\n            return finalise(sum, Ctor.precision = pr, rm, external = true);\r\n          }\r\n        } else {\r\n          Ctor.precision = pr;\r\n          return sum;\r\n        }\r\n      }\r\n\r\n      sum = t;\r\n    }\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the natural logarithm of `x` rounded to `sd` significant\r\n   * digits.\r\n   *\r\n   *  ln(-n)        = NaN\r\n   *  ln(0)         = -Infinity\r\n   *  ln(-0)        = -Infinity\r\n   *  ln(1)         = 0\r\n   *  ln(Infinity)  = Infinity\r\n   *  ln(-Infinity) = NaN\r\n   *  ln(NaN)       = NaN\r\n   *\r\n   *  ln(n) (n != 1) is non-terminating.\r\n   *\r\n   */\r\n  function naturalLogarithm(y, sd) {\r\n    var c, c0, denominator, e, numerator, rep, sum, t, wpr, x1, x2,\r\n      n = 1,\r\n      guard = 10,\r\n      x = y,\r\n      xd = x.d,\r\n      Ctor = x.constructor,\r\n      rm = Ctor.rounding,\r\n      pr = Ctor.precision;\r\n\r\n    // Is x negative or Infinity, NaN, 0 or 1?\r\n    if (x.s < 0 || !xd || !xd[0] || !x.e && xd[0] == 1 && xd.length == 1) {\r\n      return new Ctor(xd && !xd[0] ? -1 / 0 : x.s != 1 ? NaN : xd ? 0 : x);\r\n    }\r\n\r\n    if (sd == null) {\r\n      external = false;\r\n      wpr = pr;\r\n    } else {\r\n      wpr = sd;\r\n    }\r\n\r\n    Ctor.precision = wpr += guard;\r\n    c = digitsToString(xd);\r\n    c0 = c.charAt(0);\r\n\r\n    if (Math.abs(e = x.e) < 1.5e15) {\r\n\r\n      // Argument reduction.\r\n      // The series converges faster the closer the argument is to 1, so using\r\n      // ln(a^b) = b * ln(a),   ln(a) = ln(a^b) / b\r\n      // multiply the argument by itself until the leading digits of the significand are 7, 8, 9,\r\n      // 10, 11, 12 or 13, recording the number of multiplications so the sum of the series can\r\n      // later be divided by this number, then separate out the power of 10 using\r\n      // ln(a*10^b) = ln(a) + b*ln(10).\r\n\r\n      // max n is 21 (gives 0.9, 1.0 or 1.1) (9e15 / 21 = 4.2e14).\r\n      //while (c0 < 9 && c0 != 1 || c0 == 1 && c.charAt(1) > 1) {\r\n      // max n is 6 (gives 0.7 - 1.3)\r\n      while (c0 < 7 && c0 != 1 || c0 == 1 && c.charAt(1) > 3) {\r\n        x = x.times(y);\r\n        c = digitsToString(x.d);\r\n        c0 = c.charAt(0);\r\n        n++;\r\n      }\r\n\r\n      e = x.e;\r\n\r\n      if (c0 > 1) {\r\n        x = new Ctor('0.' + c);\r\n        e++;\r\n      } else {\r\n        x = new Ctor(c0 + '.' + c.slice(1));\r\n      }\r\n    } else {\r\n\r\n      // The argument reduction method above may result in overflow if the argument y is a massive\r\n      // number with exponent >= 1500000000000000 (9e15 / 6 = 1.5e15), so instead recall this\r\n      // function using ln(x*10^e) = ln(x) + e*ln(10).\r\n      t = getLn10(Ctor, wpr + 2, pr).times(e + '');\r\n      x = naturalLogarithm(new Ctor(c0 + '.' + c.slice(1)), wpr - guard).plus(t);\r\n      Ctor.precision = pr;\r\n\r\n      return sd == null ? finalise(x, pr, rm, external = true) : x;\r\n    }\r\n\r\n    // x1 is x reduced to a value near 1.\r\n    x1 = x;\r\n\r\n    // Taylor series.\r\n    // ln(y) = ln((1 + x)/(1 - x)) = 2(x + x^3/3 + x^5/5 + x^7/7 + ...)\r\n    // where x = (y - 1)/(y + 1)    (|x| < 1)\r\n    sum = numerator = x = divide(x.minus(1), x.plus(1), wpr, 1);\r\n    x2 = finalise(x.times(x), wpr, 1);\r\n    denominator = 3;\r\n\r\n    for (;;) {\r\n      numerator = finalise(numerator.times(x2), wpr, 1);\r\n      t = sum.plus(divide(numerator, new Ctor(denominator), wpr, 1));\r\n\r\n      if (digitsToString(t.d).slice(0, wpr) === digitsToString(sum.d).slice(0, wpr)) {\r\n        sum = sum.times(2);\r\n\r\n        // Reverse the argument reduction. Check that e is not 0 because, besides preventing an\r\n        // unnecessary calculation, -0 + 0 = +0 and to ensure correct rounding -0 needs to stay -0.\r\n        if (e !== 0) sum = sum.plus(getLn10(Ctor, wpr + 2, pr).times(e + ''));\r\n        sum = divide(sum, new Ctor(n), wpr, 1);\r\n\r\n        // Is rm > 3 and the first 4 rounding digits 4999, or rm < 4 (or the summation has\r\n        // been repeated previously) and the first 4 rounding digits 9999?\r\n        // If so, restart the summation with a higher precision, otherwise\r\n        // e.g. with precision: 12, rounding: 1\r\n        // ln(135520028.6126091714265381533) = 18.7246299999 when it should be 18.72463.\r\n        // `wpr - guard` is the index of first rounding digit.\r\n        if (sd == null) {\r\n          if (checkRoundingDigits(sum.d, wpr - guard, rm, rep)) {\r\n            Ctor.precision = wpr += guard;\r\n            t = numerator = x = divide(x1.minus(1), x1.plus(1), wpr, 1);\r\n            x2 = finalise(x.times(x), wpr, 1);\r\n            denominator = rep = 1;\r\n          } else {\r\n            return finalise(sum, Ctor.precision = pr, rm, external = true);\r\n          }\r\n        } else {\r\n          Ctor.precision = pr;\r\n          return sum;\r\n        }\r\n      }\r\n\r\n      sum = t;\r\n      denominator += 2;\r\n    }\r\n  }\r\n\r\n\r\n  // ±Infinity, NaN.\r\n  function nonFiniteToString(x) {\r\n    // Unsigned.\r\n    return String(x.s * x.s / 0);\r\n  }\r\n\r\n\r\n  /*\r\n   * Parse the value of a new Decimal `x` from string `str`.\r\n   */\r\n  function parseDecimal(x, str) {\r\n    var e, i, len;\r\n\r\n    // TODO BigInt str: no need to check for decimal point, exponential form or leading zeros.\r\n\r\n    // Decimal point?\r\n    if ((e = str.indexOf('.')) > -1) str = str.replace('.', '');\r\n\r\n    // Exponential form?\r\n    if ((i = str.search(/e/i)) > 0) {\r\n\r\n      // Determine exponent.\r\n      if (e < 0) e = i;\r\n      e += +str.slice(i + 1);\r\n      str = str.substring(0, i);\r\n    } else if (e < 0) {\r\n\r\n      // Integer.\r\n      e = str.length;\r\n    }\r\n\r\n    // Determine leading zeros.\r\n    for (i = 0; str.charCodeAt(i) === 48; i++);\r\n\r\n    // Determine trailing zeros.\r\n    for (len = str.length; str.charCodeAt(len - 1) === 48; --len);\r\n    str = str.slice(i, len);\r\n\r\n    if (str) {\r\n      len -= i;\r\n      x.e = e = e - i - 1;\r\n      x.d = [];\r\n\r\n      // Transform base\r\n\r\n      // e is the base 10 exponent.\r\n      // i is where to slice str to get the first word of the digits array.\r\n      i = (e + 1) % LOG_BASE;\r\n      if (e < 0) i += LOG_BASE;\r\n\r\n      if (i < len) {\r\n        if (i) x.d.push(+str.slice(0, i));\r\n        for (len -= LOG_BASE; i < len;) x.d.push(+str.slice(i, i += LOG_BASE));\r\n        str = str.slice(i);\r\n        i = LOG_BASE - str.length;\r\n      } else {\r\n        i -= len;\r\n      }\r\n\r\n      for (; i--;) str += '0';\r\n      x.d.push(+str);\r\n\r\n      if (external) {\r\n\r\n        // Overflow?\r\n        if (x.e > x.constructor.maxE) {\r\n\r\n          // Infinity.\r\n          x.d = null;\r\n          x.e = NaN;\r\n\r\n        // Underflow?\r\n        } else if (x.e < x.constructor.minE) {\r\n\r\n          // Zero.\r\n          x.e = 0;\r\n          x.d = [0];\r\n          // x.constructor.underflow = true;\r\n        } // else x.constructor.underflow = false;\r\n      }\r\n    } else {\r\n\r\n      // Zero.\r\n      x.e = 0;\r\n      x.d = [0];\r\n    }\r\n\r\n    return x;\r\n  }\r\n\r\n\r\n  /*\r\n   * Parse the value of a new Decimal `x` from a string `str`, which is not a decimal value.\r\n   */\r\n  function parseOther(x, str) {\r\n    var base, Ctor, divisor, i, isFloat, len, p, xd, xe;\r\n\r\n    if (str.indexOf('_') > -1) {\r\n      str = str.replace(/(\\d)_(?=\\d)/g, '$1');\r\n      if (isDecimal.test(str)) return parseDecimal(x, str);\r\n    } else if (str === 'Infinity' || str === 'NaN') {\r\n      if (!+str) x.s = NaN;\r\n      x.e = NaN;\r\n      x.d = null;\r\n      return x;\r\n    }\r\n\r\n    if (isHex.test(str))  {\r\n      base = 16;\r\n      str = str.toLowerCase();\r\n    } else if (isBinary.test(str))  {\r\n      base = 2;\r\n    } else if (isOctal.test(str))  {\r\n      base = 8;\r\n    } else {\r\n      throw Error(invalidArgument + str);\r\n    }\r\n\r\n    // Is there a binary exponent part?\r\n    i = str.search(/p/i);\r\n\r\n    if (i > 0) {\r\n      p = +str.slice(i + 1);\r\n      str = str.substring(2, i);\r\n    } else {\r\n      str = str.slice(2);\r\n    }\r\n\r\n    // Convert `str` as an integer then divide the result by `base` raised to a power such that the\r\n    // fraction part will be restored.\r\n    i = str.indexOf('.');\r\n    isFloat = i >= 0;\r\n    Ctor = x.constructor;\r\n\r\n    if (isFloat) {\r\n      str = str.replace('.', '');\r\n      len = str.length;\r\n      i = len - i;\r\n\r\n      // log[10](16) = 1.2041... , log[10](88) = 1.9444....\r\n      divisor = intPow(Ctor, new Ctor(base), i, i * 2);\r\n    }\r\n\r\n    xd = convertBase(str, base, BASE);\r\n    xe = xd.length - 1;\r\n\r\n    // Remove trailing zeros.\r\n    for (i = xe; xd[i] === 0; --i) xd.pop();\r\n    if (i < 0) return new Ctor(x.s * 0);\r\n    x.e = getBase10Exponent(xd, xe);\r\n    x.d = xd;\r\n    external = false;\r\n\r\n    // At what precision to perform the division to ensure exact conversion?\r\n    // maxDecimalIntegerPartDigitCount = ceil(log[10](b) * otherBaseIntegerPartDigitCount)\r\n    // log[10](2) = 0.30103, log[10](8) = 0.90309, log[10](16) = 1.20412\r\n    // E.g. ceil(1.2 * 3) = 4, so up to 4 decimal digits are needed to represent 3 hex int digits.\r\n    // maxDecimalFractionPartDigitCount = {Hex:4|Oct:3|Bin:1} * otherBaseFractionPartDigitCount\r\n    // Therefore using 4 * the number of digits of str will always be enough.\r\n    if (isFloat) x = divide(x, divisor, len * 4);\r\n\r\n    // Multiply by the binary exponent part if present.\r\n    if (p) x = x.times(Math.abs(p) < 54 ? mathpow(2, p) : Decimal.pow(2, p));\r\n    external = true;\r\n\r\n    return x;\r\n  }\r\n\r\n\r\n  /*\r\n   * sin(x) = x - x^3/3! + x^5/5! - ...\r\n   * |x| < pi/2\r\n   *\r\n   */\r\n  function sine(Ctor, x) {\r\n    var k,\r\n      len = x.d.length;\r\n\r\n    if (len < 3) {\r\n      return x.isZero() ? x : taylorSeries(Ctor, 2, x, x);\r\n    }\r\n\r\n    // Argument reduction: sin(5x) = 16*sin^5(x) - 20*sin^3(x) + 5*sin(x)\r\n    // i.e. sin(x) = 16*sin^5(x/5) - 20*sin^3(x/5) + 5*sin(x/5)\r\n    // and  sin(x) = sin(x/5)(5 + sin^2(x/5)(16sin^2(x/5) - 20))\r\n\r\n    // Estimate the optimum number of times to use the argument reduction.\r\n    k = 1.4 * Math.sqrt(len);\r\n    k = k > 16 ? 16 : k | 0;\r\n\r\n    x = x.times(1 / tinyPow(5, k));\r\n    x = taylorSeries(Ctor, 2, x, x);\r\n\r\n    // Reverse argument reduction\r\n    var sin2_x,\r\n      d5 = new Ctor(5),\r\n      d16 = new Ctor(16),\r\n      d20 = new Ctor(20);\r\n    for (; k--;) {\r\n      sin2_x = x.times(x);\r\n      x = x.times(d5.plus(sin2_x.times(d16.times(sin2_x).minus(d20))));\r\n    }\r\n\r\n    return x;\r\n  }\r\n\r\n\r\n  // Calculate Taylor series for `cos`, `cosh`, `sin` and `sinh`.\r\n  function taylorSeries(Ctor, n, x, y, isHyperbolic) {\r\n    var j, t, u, x2,\r\n      i = 1,\r\n      pr = Ctor.precision,\r\n      k = Math.ceil(pr / LOG_BASE);\r\n\r\n    external = false;\r\n    x2 = x.times(x);\r\n    u = new Ctor(y);\r\n\r\n    for (;;) {\r\n      t = divide(u.times(x2), new Ctor(n++ * n++), pr, 1);\r\n      u = isHyperbolic ? y.plus(t) : y.minus(t);\r\n      y = divide(t.times(x2), new Ctor(n++ * n++), pr, 1);\r\n      t = u.plus(y);\r\n\r\n      if (t.d[k] !== void 0) {\r\n        for (j = k; t.d[j] === u.d[j] && j--;);\r\n        if (j == -1) break;\r\n      }\r\n\r\n      j = u;\r\n      u = y;\r\n      y = t;\r\n      t = j;\r\n      i++;\r\n    }\r\n\r\n    external = true;\r\n    t.d.length = k + 1;\r\n\r\n    return t;\r\n  }\r\n\r\n\r\n  // Exponent e must be positive and non-zero.\r\n  function tinyPow(b, e) {\r\n    var n = b;\r\n    while (--e) n *= b;\r\n    return n;\r\n  }\r\n\r\n\r\n  // Return the absolute value of `x` reduced to less than or equal to half pi.\r\n  function toLessThanHalfPi(Ctor, x) {\r\n    var t,\r\n      isNeg = x.s < 0,\r\n      pi = getPi(Ctor, Ctor.precision, 1),\r\n      halfPi = pi.times(0.5);\r\n\r\n    x = x.abs();\r\n\r\n    if (x.lte(halfPi)) {\r\n      quadrant = isNeg ? 4 : 1;\r\n      return x;\r\n    }\r\n\r\n    t = x.divToInt(pi);\r\n\r\n    if (t.isZero()) {\r\n      quadrant = isNeg ? 3 : 2;\r\n    } else {\r\n      x = x.minus(t.times(pi));\r\n\r\n      // 0 <= x < pi\r\n      if (x.lte(halfPi)) {\r\n        quadrant = isOdd(t) ? (isNeg ? 2 : 3) : (isNeg ? 4 : 1);\r\n        return x;\r\n      }\r\n\r\n      quadrant = isOdd(t) ? (isNeg ? 1 : 4) : (isNeg ? 3 : 2);\r\n    }\r\n\r\n    return x.minus(pi).abs();\r\n  }\r\n\r\n\r\n  /*\r\n   * Return the value of Decimal `x` as a string in base `baseOut`.\r\n   *\r\n   * If the optional `sd` argument is present include a binary exponent suffix.\r\n   */\r\n  function toStringBinary(x, baseOut, sd, rm) {\r\n    var base, e, i, k, len, roundUp, str, xd, y,\r\n      Ctor = x.constructor,\r\n      isExp = sd !== void 0;\r\n\r\n    if (isExp) {\r\n      checkInt32(sd, 1, MAX_DIGITS);\r\n      if (rm === void 0) rm = Ctor.rounding;\r\n      else checkInt32(rm, 0, 8);\r\n    } else {\r\n      sd = Ctor.precision;\r\n      rm = Ctor.rounding;\r\n    }\r\n\r\n    if (!x.isFinite()) {\r\n      str = nonFiniteToString(x);\r\n    } else {\r\n      str = finiteToString(x);\r\n      i = str.indexOf('.');\r\n\r\n      // Use exponential notation according to `toExpPos` and `toExpNeg`? No, but if required:\r\n      // maxBinaryExponent = floor((decimalExponent + 1) * log[2](10))\r\n      // minBinaryExponent = floor(decimalExponent * log[2](10))\r\n      // log[2](10) = 3.321928094887362347870319429489390175864\r\n\r\n      if (isExp) {\r\n        base = 2;\r\n        if (baseOut == 16) {\r\n          sd = sd * 4 - 3;\r\n        } else if (baseOut == 8) {\r\n          sd = sd * 3 - 2;\r\n        }\r\n      } else {\r\n        base = baseOut;\r\n      }\r\n\r\n      // Convert the number as an integer then divide the result by its base raised to a power such\r\n      // that the fraction part will be restored.\r\n\r\n      // Non-integer.\r\n      if (i >= 0) {\r\n        str = str.replace('.', '');\r\n        y = new Ctor(1);\r\n        y.e = str.length - i;\r\n        y.d = convertBase(finiteToString(y), 10, base);\r\n        y.e = y.d.length;\r\n      }\r\n\r\n      xd = convertBase(str, 10, base);\r\n      e = len = xd.length;\r\n\r\n      // Remove trailing zeros.\r\n      for (; xd[--len] == 0;) xd.pop();\r\n\r\n      if (!xd[0]) {\r\n        str = isExp ? '0p+0' : '0';\r\n      } else {\r\n        if (i < 0) {\r\n          e--;\r\n        } else {\r\n          x = new Ctor(x);\r\n          x.d = xd;\r\n          x.e = e;\r\n          x = divide(x, y, sd, rm, 0, base);\r\n          xd = x.d;\r\n          e = x.e;\r\n          roundUp = inexact;\r\n        }\r\n\r\n        // The rounding digit, i.e. the digit after the digit that may be rounded up.\r\n        i = xd[sd];\r\n        k = base / 2;\r\n        roundUp = roundUp || xd[sd + 1] !== void 0;\r\n\r\n        roundUp = rm < 4\r\n          ? (i !== void 0 || roundUp) && (rm === 0 || rm === (x.s < 0 ? 3 : 2))\r\n          : i > k || i === k && (rm === 4 || roundUp || rm === 6 && xd[sd - 1] & 1 ||\r\n            rm === (x.s < 0 ? 8 : 7));\r\n\r\n        xd.length = sd;\r\n\r\n        if (roundUp) {\r\n\r\n          // Rounding up may mean the previous digit has to be rounded up and so on.\r\n          for (; ++xd[--sd] > base - 1;) {\r\n            xd[sd] = 0;\r\n            if (!sd) {\r\n              ++e;\r\n              xd.unshift(1);\r\n            }\r\n          }\r\n        }\r\n\r\n        // Determine trailing zeros.\r\n        for (len = xd.length; !xd[len - 1]; --len);\r\n\r\n        // E.g. [4, 11, 15] becomes 4bf.\r\n        for (i = 0, str = ''; i < len; i++) str += NUMERALS.charAt(xd[i]);\r\n\r\n        // Add binary exponent suffix?\r\n        if (isExp) {\r\n          if (len > 1) {\r\n            if (baseOut == 16 || baseOut == 8) {\r\n              i = baseOut == 16 ? 4 : 3;\r\n              for (--len; len % i; len++) str += '0';\r\n              xd = convertBase(str, base, baseOut);\r\n              for (len = xd.length; !xd[len - 1]; --len);\r\n\r\n              // xd[0] will always be be 1\r\n              for (i = 1, str = '1.'; i < len; i++) str += NUMERALS.charAt(xd[i]);\r\n            } else {\r\n              str = str.charAt(0) + '.' + str.slice(1);\r\n            }\r\n          }\r\n\r\n          str =  str + (e < 0 ? 'p' : 'p+') + e;\r\n        } else if (e < 0) {\r\n          for (; ++e;) str = '0' + str;\r\n          str = '0.' + str;\r\n        } else {\r\n          if (++e > len) for (e -= len; e-- ;) str += '0';\r\n          else if (e < len) str = str.slice(0, e) + '.' + str.slice(e);\r\n        }\r\n      }\r\n\r\n      str = (baseOut == 16 ? '0x' : baseOut == 2 ? '0b' : baseOut == 8 ? '0o' : '') + str;\r\n    }\r\n\r\n    return x.s < 0 ? '-' + str : str;\r\n  }\r\n\r\n\r\n  // Does not strip trailing zeros.\r\n  function truncate(arr, len) {\r\n    if (arr.length > len) {\r\n      arr.length = len;\r\n      return true;\r\n    }\r\n  }\r\n\r\n\r\n  // Decimal methods\r\n\r\n\r\n  /*\r\n   *  abs\r\n   *  acos\r\n   *  acosh\r\n   *  add\r\n   *  asin\r\n   *  asinh\r\n   *  atan\r\n   *  atanh\r\n   *  atan2\r\n   *  cbrt\r\n   *  ceil\r\n   *  clamp\r\n   *  clone\r\n   *  config\r\n   *  cos\r\n   *  cosh\r\n   *  div\r\n   *  exp\r\n   *  floor\r\n   *  hypot\r\n   *  ln\r\n   *  log\r\n   *  log2\r\n   *  log10\r\n   *  max\r\n   *  min\r\n   *  mod\r\n   *  mul\r\n   *  pow\r\n   *  random\r\n   *  round\r\n   *  set\r\n   *  sign\r\n   *  sin\r\n   *  sinh\r\n   *  sqrt\r\n   *  sub\r\n   *  sum\r\n   *  tan\r\n   *  tanh\r\n   *  trunc\r\n   */\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the absolute value of `x`.\r\n   *\r\n   * x {number|string|bigint|Decimal}\r\n   *\r\n   */\r\n  function abs(x) {\r\n    return new this(x).abs();\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the arccosine in radians of `x`.\r\n   *\r\n   * x {number|string|bigint|Decimal}\r\n   *\r\n   */\r\n  function acos(x) {\r\n    return new this(x).acos();\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the inverse of the hyperbolic cosine of `x`, rounded to\r\n   * `precision` significant digits using rounding mode `rounding`.\r\n   *\r\n   * x {number|string|bigint|Decimal} A value in radians.\r\n   *\r\n   */\r\n  function acosh(x) {\r\n    return new this(x).acosh();\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the sum of `x` and `y`, rounded to `precision` significant\r\n   * digits using rounding mode `rounding`.\r\n   *\r\n   * x {number|string|bigint|Decimal}\r\n   * y {number|string|bigint|Decimal}\r\n   *\r\n   */\r\n  function add(x, y) {\r\n    return new this(x).plus(y);\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the arcsine in radians of `x`, rounded to `precision`\r\n   * significant digits using rounding mode `rounding`.\r\n   *\r\n   * x {number|string|bigint|Decimal}\r\n   *\r\n   */\r\n  function asin(x) {\r\n    return new this(x).asin();\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the inverse of the hyperbolic sine of `x`, rounded to\r\n   * `precision` significant digits using rounding mode `rounding`.\r\n   *\r\n   * x {number|string|bigint|Decimal} A value in radians.\r\n   *\r\n   */\r\n  function asinh(x) {\r\n    return new this(x).asinh();\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the arctangent in radians of `x`, rounded to `precision`\r\n   * significant digits using rounding mode `rounding`.\r\n   *\r\n   * x {number|string|bigint|Decimal}\r\n   *\r\n   */\r\n  function atan(x) {\r\n    return new this(x).atan();\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the inverse of the hyperbolic tangent of `x`, rounded to\r\n   * `precision` significant digits using rounding mode `rounding`.\r\n   *\r\n   * x {number|string|bigint|Decimal} A value in radians.\r\n   *\r\n   */\r\n  function atanh(x) {\r\n    return new this(x).atanh();\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the arctangent in radians of `y/x` in the range -pi to pi\r\n   * (inclusive), rounded to `precision` significant digits using rounding mode `rounding`.\r\n   *\r\n   * Domain: [-Infinity, Infinity]\r\n   * Range: [-pi, pi]\r\n   *\r\n   * y {number|string|bigint|Decimal} The y-coordinate.\r\n   * x {number|string|bigint|Decimal} The x-coordinate.\r\n   *\r\n   * atan2(±0, -0)               = ±pi\r\n   * atan2(±0, +0)               = ±0\r\n   * atan2(±0, -x)               = ±pi for x > 0\r\n   * atan2(±0, x)                = ±0 for x > 0\r\n   * atan2(-y, ±0)               = -pi/2 for y > 0\r\n   * atan2(y, ±0)                = pi/2 for y > 0\r\n   * atan2(±y, -Infinity)        = ±pi for finite y > 0\r\n   * atan2(±y, +Infinity)        = ±0 for finite y > 0\r\n   * atan2(±Infinity, x)         = ±pi/2 for finite x\r\n   * atan2(±Infinity, -Infinity) = ±3*pi/4\r\n   * atan2(±Infinity, +Infinity) = ±pi/4\r\n   * atan2(NaN, x) = NaN\r\n   * atan2(y, NaN) = NaN\r\n   *\r\n   */\r\n  function atan2(y, x) {\r\n    y = new this(y);\r\n    x = new this(x);\r\n    var r,\r\n      pr = this.precision,\r\n      rm = this.rounding,\r\n      wpr = pr + 4;\r\n\r\n    // Either NaN\r\n    if (!y.s || !x.s) {\r\n      r = new this(NaN);\r\n\r\n    // Both ±Infinity\r\n    } else if (!y.d && !x.d) {\r\n      r = getPi(this, wpr, 1).times(x.s > 0 ? 0.25 : 0.75);\r\n      r.s = y.s;\r\n\r\n    // x is ±Infinity or y is ±0\r\n    } else if (!x.d || y.isZero()) {\r\n      r = x.s < 0 ? getPi(this, pr, rm) : new this(0);\r\n      r.s = y.s;\r\n\r\n    // y is ±Infinity or x is ±0\r\n    } else if (!y.d || x.isZero()) {\r\n      r = getPi(this, wpr, 1).times(0.5);\r\n      r.s = y.s;\r\n\r\n    // Both non-zero and finite\r\n    } else if (x.s < 0) {\r\n      this.precision = wpr;\r\n      this.rounding = 1;\r\n      r = this.atan(divide(y, x, wpr, 1));\r\n      x = getPi(this, wpr, 1);\r\n      this.precision = pr;\r\n      this.rounding = rm;\r\n      r = y.s < 0 ? r.minus(x) : r.plus(x);\r\n    } else {\r\n      r = this.atan(divide(y, x, wpr, 1));\r\n    }\r\n\r\n    return r;\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the cube root of `x`, rounded to `precision` significant\r\n   * digits using rounding mode `rounding`.\r\n   *\r\n   * x {number|string|bigint|Decimal}\r\n   *\r\n   */\r\n  function cbrt(x) {\r\n    return new this(x).cbrt();\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is `x` rounded to an integer using `ROUND_CEIL`.\r\n   *\r\n   * x {number|string|bigint|Decimal}\r\n   *\r\n   */\r\n  function ceil(x) {\r\n    return finalise(x = new this(x), x.e + 1, 2);\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is `x` clamped to the range delineated by `min` and `max`.\r\n   *\r\n   * x {number|string|bigint|Decimal}\r\n   * min {number|string|bigint|Decimal}\r\n   * max {number|string|bigint|Decimal}\r\n   *\r\n   */\r\n  function clamp(x, min, max) {\r\n    return new this(x).clamp(min, max);\r\n  }\r\n\r\n\r\n  /*\r\n   * Configure global settings for a Decimal constructor.\r\n   *\r\n   * `obj` is an object with one or more of the following properties,\r\n   *\r\n   *   precision  {number}\r\n   *   rounding   {number}\r\n   *   toExpNeg   {number}\r\n   *   toExpPos   {number}\r\n   *   maxE       {number}\r\n   *   minE       {number}\r\n   *   modulo     {number}\r\n   *   crypto     {boolean|number}\r\n   *   defaults   {true}\r\n   *\r\n   * E.g. Decimal.config({ precision: 20, rounding: 4 })\r\n   *\r\n   */\r\n  function config(obj) {\r\n    if (!obj || typeof obj !== 'object') throw Error(decimalError + 'Object expected');\r\n    var i, p, v,\r\n      useDefaults = obj.defaults === true,\r\n      ps = [\r\n        'precision', 1, MAX_DIGITS,\r\n        'rounding', 0, 8,\r\n        'toExpNeg', -EXP_LIMIT, 0,\r\n        'toExpPos', 0, EXP_LIMIT,\r\n        'maxE', 0, EXP_LIMIT,\r\n        'minE', -EXP_LIMIT, 0,\r\n        'modulo', 0, 9\r\n      ];\r\n\r\n    for (i = 0; i < ps.length; i += 3) {\r\n      if (p = ps[i], useDefaults) this[p] = DEFAULTS[p];\r\n      if ((v = obj[p]) !== void 0) {\r\n        if (mathfloor(v) === v && v >= ps[i + 1] && v <= ps[i + 2]) this[p] = v;\r\n        else throw Error(invalidArgument + p + ': ' + v);\r\n      }\r\n    }\r\n\r\n    if (p = 'crypto', useDefaults) this[p] = DEFAULTS[p];\r\n    if ((v = obj[p]) !== void 0) {\r\n      if (v === true || v === false || v === 0 || v === 1) {\r\n        if (v) {\r\n          if (typeof crypto != 'undefined' && crypto &&\r\n            (crypto.getRandomValues || crypto.randomBytes)) {\r\n            this[p] = true;\r\n          } else {\r\n            throw Error(cryptoUnavailable);\r\n          }\r\n        } else {\r\n          this[p] = false;\r\n        }\r\n      } else {\r\n        throw Error(invalidArgument + p + ': ' + v);\r\n      }\r\n    }\r\n\r\n    return this;\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the cosine of `x`, rounded to `precision` significant\r\n   * digits using rounding mode `rounding`.\r\n   *\r\n   * x {number|string|bigint|Decimal} A value in radians.\r\n   *\r\n   */\r\n  function cos(x) {\r\n    return new this(x).cos();\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the hyperbolic cosine of `x`, rounded to precision\r\n   * significant digits using rounding mode `rounding`.\r\n   *\r\n   * x {number|string|bigint|Decimal} A value in radians.\r\n   *\r\n   */\r\n  function cosh(x) {\r\n    return new this(x).cosh();\r\n  }\r\n\r\n\r\n  /*\r\n   * Create and return a Decimal constructor with the same configuration properties as this Decimal\r\n   * constructor.\r\n   *\r\n   */\r\n  function clone(obj) {\r\n    var i, p, ps;\r\n\r\n    /*\r\n     * The Decimal constructor and exported function.\r\n     * Return a new Decimal instance.\r\n     *\r\n     * v {number|string|bigint|Decimal} A numeric value.\r\n     *\r\n     */\r\n    function Decimal(v) {\r\n      var e, i, t,\r\n        x = this;\r\n\r\n      // Decimal called without new.\r\n      if (!(x instanceof Decimal)) return new Decimal(v);\r\n\r\n      // Retain a reference to this Decimal constructor, and shadow Decimal.prototype.constructor\r\n      // which points to Object.\r\n      x.constructor = Decimal;\r\n\r\n      if (isDecimalInstance(v)) {\r\n        x.s = v.s;\r\n\r\n        if (external) {\r\n          if (!v.d || v.e > Decimal.maxE) {\r\n\r\n            // Infinity.\r\n            x.e = NaN;\r\n            x.d = null;\r\n          } else if (v.e < Decimal.minE) {\r\n\r\n            // Zero.\r\n            x.e = 0;\r\n            x.d = [0];\r\n          } else {\r\n            x.e = v.e;\r\n            x.d = v.d.slice();\r\n          }\r\n        } else {\r\n          x.e = v.e;\r\n          x.d = v.d ? v.d.slice() : v.d;\r\n        }\r\n\r\n        return;\r\n      }\r\n\r\n      t = typeof v;\r\n\r\n      if (t === 'number') {\r\n        if (v === 0) {\r\n          x.s = 1 / v < 0 ? -1 : 1;\r\n          x.e = 0;\r\n          x.d = [0];\r\n          return;\r\n        }\r\n\r\n        if (v < 0) {\r\n          v = -v;\r\n          x.s = -1;\r\n        } else {\r\n          x.s = 1;\r\n        }\r\n\r\n        // Fast path for small integers.\r\n        if (v === ~~v && v < 1e7) {\r\n          for (e = 0, i = v; i >= 10; i /= 10) e++;\r\n\r\n          if (external) {\r\n            if (e > Decimal.maxE) {\r\n              x.e = NaN;\r\n              x.d = null;\r\n            } else if (e < Decimal.minE) {\r\n              x.e = 0;\r\n              x.d = [0];\r\n            } else {\r\n              x.e = e;\r\n              x.d = [v];\r\n            }\r\n          } else {\r\n            x.e = e;\r\n            x.d = [v];\r\n          }\r\n\r\n          return;\r\n        }\r\n\r\n        // Infinity or NaN?\r\n        if (v * 0 !== 0) {\r\n          if (!v) x.s = NaN;\r\n          x.e = NaN;\r\n          x.d = null;\r\n          return;\r\n        }\r\n\r\n        return parseDecimal(x, v.toString());\r\n      }\r\n\r\n      if (t === 'string') {\r\n        if ((i = v.charCodeAt(0)) === 45) {  // minus sign\r\n          v = v.slice(1);\r\n          x.s = -1;\r\n        } else {\r\n          if (i === 43) v = v.slice(1);  // plus sign\r\n          x.s = 1;\r\n        }\r\n\r\n        return isDecimal.test(v) ? parseDecimal(x, v) : parseOther(x, v);\r\n      }\r\n\r\n      if (t === 'bigint') {\r\n        if (v < 0) {\r\n          v = -v;\r\n          x.s = -1;\r\n        } else {\r\n          x.s = 1;\r\n        }\r\n\r\n        return parseDecimal(x, v.toString());\r\n      }\r\n\r\n      throw Error(invalidArgument + v);\r\n    }\r\n\r\n    Decimal.prototype = P;\r\n\r\n    Decimal.ROUND_UP = 0;\r\n    Decimal.ROUND_DOWN = 1;\r\n    Decimal.ROUND_CEIL = 2;\r\n    Decimal.ROUND_FLOOR = 3;\r\n    Decimal.ROUND_HALF_UP = 4;\r\n    Decimal.ROUND_HALF_DOWN = 5;\r\n    Decimal.ROUND_HALF_EVEN = 6;\r\n    Decimal.ROUND_HALF_CEIL = 7;\r\n    Decimal.ROUND_HALF_FLOOR = 8;\r\n    Decimal.EUCLID = 9;\r\n\r\n    Decimal.config = Decimal.set = config;\r\n    Decimal.clone = clone;\r\n    Decimal.isDecimal = isDecimalInstance;\r\n\r\n    Decimal.abs = abs;\r\n    Decimal.acos = acos;\r\n    Decimal.acosh = acosh;        // ES6\r\n    Decimal.add = add;\r\n    Decimal.asin = asin;\r\n    Decimal.asinh = asinh;        // ES6\r\n    Decimal.atan = atan;\r\n    Decimal.atanh = atanh;        // ES6\r\n    Decimal.atan2 = atan2;\r\n    Decimal.cbrt = cbrt;          // ES6\r\n    Decimal.ceil = ceil;\r\n    Decimal.clamp = clamp;\r\n    Decimal.cos = cos;\r\n    Decimal.cosh = cosh;          // ES6\r\n    Decimal.div = div;\r\n    Decimal.exp = exp;\r\n    Decimal.floor = floor;\r\n    Decimal.hypot = hypot;        // ES6\r\n    Decimal.ln = ln;\r\n    Decimal.log = log;\r\n    Decimal.log10 = log10;        // ES6\r\n    Decimal.log2 = log2;          // ES6\r\n    Decimal.max = max;\r\n    Decimal.min = min;\r\n    Decimal.mod = mod;\r\n    Decimal.mul = mul;\r\n    Decimal.pow = pow;\r\n    Decimal.random = random;\r\n    Decimal.round = round;\r\n    Decimal.sign = sign;          // ES6\r\n    Decimal.sin = sin;\r\n    Decimal.sinh = sinh;          // ES6\r\n    Decimal.sqrt = sqrt;\r\n    Decimal.sub = sub;\r\n    Decimal.sum = sum;\r\n    Decimal.tan = tan;\r\n    Decimal.tanh = tanh;          // ES6\r\n    Decimal.trunc = trunc;        // ES6\r\n\r\n    if (obj === void 0) obj = {};\r\n    if (obj) {\r\n      if (obj.defaults !== true) {\r\n        ps = ['precision', 'rounding', 'toExpNeg', 'toExpPos', 'maxE', 'minE', 'modulo', 'crypto'];\r\n        for (i = 0; i < ps.length;) if (!obj.hasOwnProperty(p = ps[i++])) obj[p] = this[p];\r\n      }\r\n    }\r\n\r\n    Decimal.config(obj);\r\n\r\n    return Decimal;\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is `x` divided by `y`, rounded to `precision` significant\r\n   * digits using rounding mode `rounding`.\r\n   *\r\n   * x {number|string|bigint|Decimal}\r\n   * y {number|string|bigint|Decimal}\r\n   *\r\n   */\r\n  function div(x, y) {\r\n    return new this(x).div(y);\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the natural exponential of `x`, rounded to `precision`\r\n   * significant digits using rounding mode `rounding`.\r\n   *\r\n   * x {number|string|bigint|Decimal} The power to which to raise the base of the natural log.\r\n   *\r\n   */\r\n  function exp(x) {\r\n    return new this(x).exp();\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is `x` round to an integer using `ROUND_FLOOR`.\r\n   *\r\n   * x {number|string|bigint|Decimal}\r\n   *\r\n   */\r\n  function floor(x) {\r\n    return finalise(x = new this(x), x.e + 1, 3);\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the square root of the sum of the squares of the arguments,\r\n   * rounded to `precision` significant digits using rounding mode `rounding`.\r\n   *\r\n   * hypot(a, b, ...) = sqrt(a^2 + b^2 + ...)\r\n   *\r\n   * arguments {number|string|bigint|Decimal}\r\n   *\r\n   */\r\n  function hypot() {\r\n    var i, n,\r\n      t = new this(0);\r\n\r\n    external = false;\r\n\r\n    for (i = 0; i < arguments.length;) {\r\n      n = new this(arguments[i++]);\r\n      if (!n.d) {\r\n        if (n.s) {\r\n          external = true;\r\n          return new this(1 / 0);\r\n        }\r\n        t = n;\r\n      } else if (t.d) {\r\n        t = t.plus(n.times(n));\r\n      }\r\n    }\r\n\r\n    external = true;\r\n\r\n    return t.sqrt();\r\n  }\r\n\r\n\r\n  /*\r\n   * Return true if object is a Decimal instance (where Decimal is any Decimal constructor),\r\n   * otherwise return false.\r\n   *\r\n   */\r\n  function isDecimalInstance(obj) {\r\n    return obj instanceof Decimal || obj && obj.toStringTag === tag || false;\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the natural logarithm of `x`, rounded to `precision`\r\n   * significant digits using rounding mode `rounding`.\r\n   *\r\n   * x {number|string|bigint|Decimal}\r\n   *\r\n   */\r\n  function ln(x) {\r\n    return new this(x).ln();\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the log of `x` to the base `y`, or to base 10 if no base\r\n   * is specified, rounded to `precision` significant digits using rounding mode `rounding`.\r\n   *\r\n   * log[y](x)\r\n   *\r\n   * x {number|string|bigint|Decimal} The argument of the logarithm.\r\n   * y {number|string|bigint|Decimal} The base of the logarithm.\r\n   *\r\n   */\r\n  function log(x, y) {\r\n    return new this(x).log(y);\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the base 2 logarithm of `x`, rounded to `precision`\r\n   * significant digits using rounding mode `rounding`.\r\n   *\r\n   * x {number|string|bigint|Decimal}\r\n   *\r\n   */\r\n  function log2(x) {\r\n    return new this(x).log(2);\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the base 10 logarithm of `x`, rounded to `precision`\r\n   * significant digits using rounding mode `rounding`.\r\n   *\r\n   * x {number|string|bigint|Decimal}\r\n   *\r\n   */\r\n  function log10(x) {\r\n    return new this(x).log(10);\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the maximum of the arguments.\r\n   *\r\n   * arguments {number|string|bigint|Decimal}\r\n   *\r\n   */\r\n  function max() {\r\n    return maxOrMin(this, arguments, -1);\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the minimum of the arguments.\r\n   *\r\n   * arguments {number|string|bigint|Decimal}\r\n   *\r\n   */\r\n  function min() {\r\n    return maxOrMin(this, arguments, 1);\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is `x` modulo `y`, rounded to `precision` significant digits\r\n   * using rounding mode `rounding`.\r\n   *\r\n   * x {number|string|bigint|Decimal}\r\n   * y {number|string|bigint|Decimal}\r\n   *\r\n   */\r\n  function mod(x, y) {\r\n    return new this(x).mod(y);\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is `x` multiplied by `y`, rounded to `precision` significant\r\n   * digits using rounding mode `rounding`.\r\n   *\r\n   * x {number|string|bigint|Decimal}\r\n   * y {number|string|bigint|Decimal}\r\n   *\r\n   */\r\n  function mul(x, y) {\r\n    return new this(x).mul(y);\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is `x` raised to the power `y`, rounded to precision\r\n   * significant digits using rounding mode `rounding`.\r\n   *\r\n   * x {number|string|bigint|Decimal} The base.\r\n   * y {number|string|bigint|Decimal} The exponent.\r\n   *\r\n   */\r\n  function pow(x, y) {\r\n    return new this(x).pow(y);\r\n  }\r\n\r\n\r\n  /*\r\n   * Returns a new Decimal with a random value equal to or greater than 0 and less than 1, and with\r\n   * `sd`, or `Decimal.precision` if `sd` is omitted, significant digits (or less if trailing zeros\r\n   * are produced).\r\n   *\r\n   * [sd] {number} Significant digits. Integer, 0 to MAX_DIGITS inclusive.\r\n   *\r\n   */\r\n  function random(sd) {\r\n    var d, e, k, n,\r\n      i = 0,\r\n      r = new this(1),\r\n      rd = [];\r\n\r\n    if (sd === void 0) sd = this.precision;\r\n    else checkInt32(sd, 1, MAX_DIGITS);\r\n\r\n    k = Math.ceil(sd / LOG_BASE);\r\n\r\n    if (!this.crypto) {\r\n      for (; i < k;) rd[i++] = Math.random() * 1e7 | 0;\r\n\r\n    // Browsers supporting crypto.getRandomValues.\r\n    } else if (crypto.getRandomValues) {\r\n      d = crypto.getRandomValues(new Uint32Array(k));\r\n\r\n      for (; i < k;) {\r\n        n = d[i];\r\n\r\n        // 0 <= n < 4294967296\r\n        // Probability n >= 4.29e9, is 4967296 / 4294967296 = 0.00116 (1 in 865).\r\n        if (n >= 4.29e9) {\r\n          d[i] = crypto.getRandomValues(new Uint32Array(1))[0];\r\n        } else {\r\n\r\n          // 0 <= n <= 4289999999\r\n          // 0 <= (n % 1e7) <= 9999999\r\n          rd[i++] = n % 1e7;\r\n        }\r\n      }\r\n\r\n    // Node.js supporting crypto.randomBytes.\r\n    } else if (crypto.randomBytes) {\r\n\r\n      // buffer\r\n      d = crypto.randomBytes(k *= 4);\r\n\r\n      for (; i < k;) {\r\n\r\n        // 0 <= n < 2147483648\r\n        n = d[i] + (d[i + 1] << 8) + (d[i + 2] << 16) + ((d[i + 3] & 0x7f) << 24);\r\n\r\n        // Probability n >= 2.14e9, is 7483648 / 2147483648 = 0.0035 (1 in 286).\r\n        if (n >= 2.14e9) {\r\n          crypto.randomBytes(4).copy(d, i);\r\n        } else {\r\n\r\n          // 0 <= n <= 2139999999\r\n          // 0 <= (n % 1e7) <= 9999999\r\n          rd.push(n % 1e7);\r\n          i += 4;\r\n        }\r\n      }\r\n\r\n      i = k / 4;\r\n    } else {\r\n      throw Error(cryptoUnavailable);\r\n    }\r\n\r\n    k = rd[--i];\r\n    sd %= LOG_BASE;\r\n\r\n    // Convert trailing digits to zeros according to sd.\r\n    if (k && sd) {\r\n      n = mathpow(10, LOG_BASE - sd);\r\n      rd[i] = (k / n | 0) * n;\r\n    }\r\n\r\n    // Remove trailing words which are zero.\r\n    for (; rd[i] === 0; i--) rd.pop();\r\n\r\n    // Zero?\r\n    if (i < 0) {\r\n      e = 0;\r\n      rd = [0];\r\n    } else {\r\n      e = -1;\r\n\r\n      // Remove leading words which are zero and adjust exponent accordingly.\r\n      for (; rd[0] === 0; e -= LOG_BASE) rd.shift();\r\n\r\n      // Count the digits of the first word of rd to determine leading zeros.\r\n      for (k = 1, n = rd[0]; n >= 10; n /= 10) k++;\r\n\r\n      // Adjust the exponent for leading zeros of the first word of rd.\r\n      if (k < LOG_BASE) e -= LOG_BASE - k;\r\n    }\r\n\r\n    r.e = e;\r\n    r.d = rd;\r\n\r\n    return r;\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is `x` rounded to an integer using rounding mode `rounding`.\r\n   *\r\n   * To emulate `Math.round`, set rounding to 7 (ROUND_HALF_CEIL).\r\n   *\r\n   * x {number|string|bigint|Decimal}\r\n   *\r\n   */\r\n  function round(x) {\r\n    return finalise(x = new this(x), x.e + 1, this.rounding);\r\n  }\r\n\r\n\r\n  /*\r\n   * Return\r\n   *   1    if x > 0,\r\n   *  -1    if x < 0,\r\n   *   0    if x is 0,\r\n   *  -0    if x is -0,\r\n   *   NaN  otherwise\r\n   *\r\n   * x {number|string|bigint|Decimal}\r\n   *\r\n   */\r\n  function sign(x) {\r\n    x = new this(x);\r\n    return x.d ? (x.d[0] ? x.s : 0 * x.s) : x.s || NaN;\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the sine of `x`, rounded to `precision` significant digits\r\n   * using rounding mode `rounding`.\r\n   *\r\n   * x {number|string|bigint|Decimal} A value in radians.\r\n   *\r\n   */\r\n  function sin(x) {\r\n    return new this(x).sin();\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the hyperbolic sine of `x`, rounded to `precision`\r\n   * significant digits using rounding mode `rounding`.\r\n   *\r\n   * x {number|string|bigint|Decimal} A value in radians.\r\n   *\r\n   */\r\n  function sinh(x) {\r\n    return new this(x).sinh();\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the square root of `x`, rounded to `precision` significant\r\n   * digits using rounding mode `rounding`.\r\n   *\r\n   * x {number|string|bigint|Decimal}\r\n   *\r\n   */\r\n  function sqrt(x) {\r\n    return new this(x).sqrt();\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is `x` minus `y`, rounded to `precision` significant digits\r\n   * using rounding mode `rounding`.\r\n   *\r\n   * x {number|string|bigint|Decimal}\r\n   * y {number|string|bigint|Decimal}\r\n   *\r\n   */\r\n  function sub(x, y) {\r\n    return new this(x).sub(y);\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the sum of the arguments, rounded to `precision`\r\n   * significant digits using rounding mode `rounding`.\r\n   *\r\n   * Only the result is rounded, not the intermediate calculations.\r\n   *\r\n   * arguments {number|string|bigint|Decimal}\r\n   *\r\n   */\r\n  function sum() {\r\n    var i = 0,\r\n      args = arguments,\r\n      x = new this(args[i]);\r\n\r\n    external = false;\r\n    for (; x.s && ++i < args.length;) x = x.plus(args[i]);\r\n    external = true;\r\n\r\n    return finalise(x, this.precision, this.rounding);\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the tangent of `x`, rounded to `precision` significant\r\n   * digits using rounding mode `rounding`.\r\n   *\r\n   * x {number|string|bigint|Decimal} A value in radians.\r\n   *\r\n   */\r\n  function tan(x) {\r\n    return new this(x).tan();\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is the hyperbolic tangent of `x`, rounded to `precision`\r\n   * significant digits using rounding mode `rounding`.\r\n   *\r\n   * x {number|string|bigint|Decimal} A value in radians.\r\n   *\r\n   */\r\n  function tanh(x) {\r\n    return new this(x).tanh();\r\n  }\r\n\r\n\r\n  /*\r\n   * Return a new Decimal whose value is `x` truncated to an integer.\r\n   *\r\n   * x {number|string|bigint|Decimal}\r\n   *\r\n   */\r\n  function trunc(x) {\r\n    return finalise(x = new this(x), x.e + 1, 1);\r\n  }\r\n\r\n\r\n  // Create and configure initial Decimal constructor.\r\n  Decimal = clone(DEFAULTS);\r\n  Decimal.prototype.constructor = Decimal;\r\n  Decimal['default'] = Decimal.Decimal = Decimal;\r\n\r\n  // Create the internal constants from their string values.\r\n  LN10 = new Decimal(LN10);\r\n  PI = new Decimal(PI);\r\n\r\n\r\n  // Export.\r\n\r\n\r\n  // AMD.\r\n  if (typeof define == 'function' && define.amd) {\r\n    define(function () {\r\n      return Decimal;\r\n    });\r\n\r\n  // Node and other environments that support module.exports.\r\n  } else if (typeof module != 'undefined' && module.exports) {\r\n    if (typeof Symbol == 'function' && typeof Symbol.iterator == 'symbol') {\r\n      P[Symbol['for']('nodejs.util.inspect.custom')] = P.toString;\r\n      P[Symbol.toStringTag] = 'Decimal';\r\n    }\r\n\r\n    module.exports = Decimal;\r\n\r\n  // Browser.\r\n  } else {\r\n    if (!globalScope) {\r\n      globalScope = typeof self != 'undefined' && self && self.self == self ? self : window;\r\n    }\r\n\r\n    noConflict = globalScope.Decimal;\r\n    Decimal.noConflict = function () {\r\n      globalScope.Decimal = noConflict;\r\n      return Decimal;\r\n    };\r\n\r\n    globalScope.Decimal = Decimal;\r\n  }\r\n})(this);\r\n";
    }
    // КОНЕЦ ВСТРОЕННЫХ БИБЛИОТЕК АНАЛИЗА
})();
