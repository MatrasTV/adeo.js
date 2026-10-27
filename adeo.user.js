// ==UserScript==
// @name         ADEO — прайсы и расписание поставщиков
// @namespace    admin.adeo.pro
// @version      3.4.0
// @description  Работа с прайсами и мастер еженедельного расписания поставщиков CRM
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
// @match        https://crm.adeo.pro/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const SROKI_URL = 'https://192.168.3.19:6001/sroki';
    const PAGE_SIZES = [10, 50, 100, 500, 1000, 3000, 5000, 10000, 100000];
    const initializedFields = new WeakSet();
    const filteredRowDisplays = new WeakMap();
    const supplierRowHeights = new WeakMap();
    const copyFeedback = new WeakMap();
    const priceDifferenceValues = new WeakMap();
    const loadingRequests = new Map();
    let hideReg = true;

    // Следим за появлением элементов и обновлением текста без постоянного опроса.
    function observePage(update) {
        const observer = new MutationObserver(mutations => {
            // Тики таймера загрузки не должны повторно обходить всю таблицу.
            if (mutations.every(mutation => {
                const element = mutation.target.nodeType === 3 ? mutation.target.parentElement : mutation.target;
                return element?.closest?.('.adeo-loading');
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

    // Используем местную дату и ограничиваем день последним днём предыдущего месяца.
    function getPreviousMonthDate(now = new Date()) {
        const date = new Date(now.getFullYear(), now.getMonth(), 1);
        date.setMonth(date.getMonth() - 1);
        const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
        date.setDate(Math.min(now.getDate(), lastDay));
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    function initPriceRelevance() {
        observePage(() => {
            setFileAcceptAttribute('input[type="file"][name="price"]');
            fillFieldOnce('input[name="outStart"]', '5');
            fillFieldOnce('input[name="start_date"]', getPreviousMonthDate());
            setCheckboxOnce(document.querySelector('input[name="orders_avg_cost"]'), false);
            setCheckboxOnce(document.querySelector('input[name="orders_max_cost"]'), false);
        });
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

    function scheduleDraftPayload(draft, supplierId) {
        const start = draft.haveDelivery ? `${schedulePad(draft.deliveryHour)}:00` : null;
        const end = draft.haveDelivery ? (draft.deliveryHour === 23 ? '23:59' : `${schedulePad(draft.deliveryHour + 1)}:00`) : null;
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
            if (draft.haveDelivery) {
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
            if (!Number.isInteger(row.leadDays) || row.leadDays < 0) throw new Error('Срок доставки — целое неотрицательное число дней.');
        }
        return SCHEDULE_WEEKDAYS.map((name, weekday) => {
            const date = nextScheduleWeekday(startDate, weekday);
            const enabled = orderDays.includes(weekday);
            return { date, weekday, enabled, nfiles: [nfile], entries: enabled ? template.map(row => ({
                uid: String(++scheduleDraftSequence), nfile, sendDate: date, sendTime: row.sendTime,
                haveDelivery: row.haveDelivery, deliveryDate: row.haveDelivery ? nextScheduleDelivery(addScheduleDays(date, row.leadDays), deliveryDays) : '',
                deliveryHour: row.deliveryHour
            })) : [] };
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
                if (isWeeklySchedule(event) && scheduleWeekday(day) === scheduleWeekday(group.date)) {
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
                const payload = scheduleDraftPayload(draft, supplierId);
                if (decision === 'add') {
                    const sameWeeklySlot = weekly.filter(series => series.instances.some(event =>
                        scheduleScopesOverlap(event.nfile, draft.nfile) && scheduleTime(event.ordersAcceptedAt) === draft.sendTime));
                    const identical = sameWeeklySlot.some(series => series.first && series.instances.some(event =>
                        scheduleDay(event.ordersAcceptedAt) <= group.date && scheduleRepeatSignature(event) === scheduleRepeatSignature(payload)));
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
        const subject = operation?.type === 'remove' ? 'удалении записи расписания' : 'создании еженедельной записи';
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
            ? events.some(event => isWeeklySchedule(event) && scheduleRecordSignature(event) === scheduleRecordSignature(operation.payload))
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
            targetDate: addScheduleDays(scheduleDay(), 2), nfile: null, storages: [], orderDays: [0, 1, 2, 3, 4], deliveryDays: [0, 1, 2, 3, 4],
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
            if (delivery) note(box, 'Будни — круглосуточно. Суббота — до 16:00. Воскресенье — выходной.'); parent.append(box);
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
                    const warehouse = state.mode === 'copy' ? (scheduleNfile(row.nfile) ? ` · склад ${row.nfile}` : ' · все склады') : '';
                    summary.replaceChildren(
                        scheduleElement('span', `${row.sendTime || 'Укажите время'}${warehouse}`, 'adeo-schedule-row-time'),
                        scheduleElement('span', row.haveDelivery ? `${displayScheduleDay(row.deliveryDate, false)} · ${scheduleHourLabel(row.deliveryHour)}` : 'Без доставки', 'adeo-schedule-row-delivery-text')
                    );
                    if (errors.length) summary.append(scheduleElement('span', 'Требует исправления', 'adeo-schedule-row-issue'));
                    summary.parentElement.classList.toggle('adeo-schedule-row-invalid', errors.length > 0);
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
            check(box, 'Указать доставку', row.haveDelivery, value => {
                row.haveDelivery = value;
                if (!template && value && !row.deliveryDate) row.deliveryDate = nextScheduleDelivery(row.sendDate, state.deliveryDays);
                render();
            });
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
                    nextScheduleDelivery(state.startDate, state.deliveryDays); state.phase = 'template'; render();
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
                    nextScheduleDelivery(state.targetDate, state.deliveryDays);
                    assertContext(); setBusy(true);
                    try {
                        const events = await adapter.list(supplierId);
                        const source = events.filter(event => isWeeklySchedule(event) && scheduleDay(event.ordersAcceptedAt) === state.sourceDate);
                        if (!source.length) throw new Error('CRM не вернула еженедельных записей для этого дня. Выберите день с загруженным расписанием.');
                        const offset = (parseScheduleDay(state.targetDate) - parseScheduleDay(state.sourceDate)) / 86400000;
                        const entries = source.map(event => scheduleEventToDraft(event, offset));
                        state.events = events; state.groups = [{ date: state.targetDate, weekday: scheduleWeekday(state.targetDate), enabled: true,
                            nfiles: [...new Map(entries.map(row => [scheduleNfile(row.nfile), row.nfile])).values()], entries }];
                        state.dirty = true; state.phase = 'review';
                    } finally { setBusy(false); render(); }
                }, 'primary');
            }
        }

        function renderSaturdayFix(parent) {
            const rows = allDrafts().filter(row => {
                try { return row.haveDelivery && row.deliveryDate && scheduleWeekday(row.deliveryDate) === 5 && row.deliveryHour > 15; }
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
                        group.entries.push({ uid: String(++scheduleDraftSequence), nfile: state.mode === 'new' ? state.nfile : group.nfiles[0],
                            sendDate: group.date, sendTime: '09:00', haveDelivery: true, deliveryDate: nextScheduleDelivery(addScheduleDays(group.date, 1), state.deliveryDays), deliveryHour: 15, expanded: true }); state.dirty = true; render();
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
            note(content, 'Новые записи будут повторяться еженедельно. «Заменить» прекращает показанные прежние повторы с указанной будущей даты и удаляет разовые записи этой даты в затронутых складах. Прошедшие даты сохраняются.');
            if (state.groups.some(group => group.enabled && group.nfiles.some(value => scheduleNfile(value) === ''))) {
                note(content, 'Выбраны все склады: замена включает правила отдельных складов выбранных дней недели. Проверьте их список перед подтверждением.');
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
                    const active = [...conflict.weekly.filter(series => series.first).map(series => ({ event: series.first, label: 'Еженедельно' })), ...conflict.once.map(event => ({ event, label: 'Разовая' }))];
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
            if (job.skipped) note(content, `Одинаковых еженедельных правил уже было в CRM: ${job.skipped}. Повторно они не создавались.`);
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
                    state.groups = buildScheduleWeek(state.template, state.orderDays, state.deliveryDays, state.startDate, state.nfile);
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
        else if (window.location.hostname === 'crm.adeo.pro') initSupplierCalendar();
    }

    installLoadingProgress();
    prepareInitialCompareRequest();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else {
        init();
    }
})();
