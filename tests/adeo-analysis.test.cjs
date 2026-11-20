const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { resolve, basename } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(resolve(__dirname, '../adeo.user.js'), 'utf8');
const xlsxPath = process.env.ADEO_XLSX_LIBRARY || resolve(__dirname, '../assets/vendor/xlsx-mini-0.20.3.js');
const decimalPath = process.env.ADEO_DECIMAL_LIBRARY || resolve(__dirname, '../assets/vendor/decimal-10.6.0.js');
const librariesAvailable = xlsxPath && decimalPath && existsSync(xlsxPath) && existsSync(decimalPath);
let XLSX, Decimal, chromium;
if (librariesAvailable) { XLSX = require(xlsxPath); Decimal = require(decimalPath); }
try { ({ chromium } = require('playwright')); } catch { /* Браузерные сценарии требуют Playwright. */ }
const context = vm.createContext({});
vm.runInContext(source.replace('    installLoadingProgress();', '    globalThis.calculate = calculateRelevanceWorkbook; globalThis.workerSources = getRelevanceWorkerSources; return;'), context);
const plain = value => JSON.parse(JSON.stringify(value));
const skipLibraries = !librariesAvailable && 'Задайте ADEO_XLSX_LIBRARY и ADEO_DECIMAL_LIBRARY: пути к SheetJS 0.20.3 и decimal.js 10.6.0';

test('Установочный файл содержит обе библиотеки и не требует загрузки модулей по сети', () => {
    const bundled = {};
    vm.runInNewContext(context.workerSources(), bundled);
    assert.equal(bundled.XLSX.version, '0.20.3');
    assert.equal(new bundled.Decimal('0.1').plus('0.2').toString(), '0.3');
    assert.doesNotMatch(source.slice(0, source.indexOf('// НАЧАЛО ВСТРОЕННЫХ БИБЛИОТЕК АНАЛИЗА')), /importScripts\(|libraries:|RELEVANCE_XLSX_URL/);
});

function workbook(rows, name = 'price_analyse_result') {
    const result = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(result, XLSX.utils.aoa_to_sheet(rows), name);
    return result;
}
function rows() {
    return [[null, null, null, null, null, ' Заказов\u00a0АДЕО с 2026-10-19 ', 'Мин. цена заказа'],
        ['Производитель', 'Артикул', 'Наименование', 'Количество', 'Цена'], ['Бренд', '1', 'Товар', '3', '10', '2', '12']];
}
function calculate(book, progress) { return plain(context.calculate(book, XLSX, Decimal, progress)); }

test('Расчёт повторяет правила ARM, предупреждения, нулевые цены и точность сумм', { skip: skipLibraries }, () => {
    const data = rows();
    data.push(['B', '2', 'Равно', 0, '12.99', 0, '12.99'], ['B', '3', 'Дороже', 4, 15, 2, 10],
        ['B', '4', 'Ошибка', 'нет', 10, 2, 'ошибка'], ['B', '5', 'Без заказа', 2, 3, 2, null], ['B', '6', 'Ноль', 1, 0, 1, 1]);
    const progress = [];
    const result = calculate(workbook(data), (...args) => progress.push(args));
    assert.deepEqual(result.result, { rub_sum: '20', ordered_from_supplier: 3, total_orders: 5, average_percent: '4.44', maximum_rub: '40' });
    assert.equal(result.meta.skipped_rows, 1);
    assert.equal(result.meta.warning_count, 3);
    assert.deepEqual(progress.at(-1), [6, 6]);
    const exact = rows(); exact[2] = ['B', '1', 'Сумма', 3, '90071992547409930.10', 2, '90071992547409930.10'];
    assert.equal(calculate(workbook(exact)).result.rub_sum, '180143985094819860');
    const zero = rows(); zero[2][4] = 0;
    assert.equal(calculate(workbook(zero)).result.average_percent, null);
});

test('Поиск листа и динамических столбцов, ошибки заголовков и формулы без готового значения', { skip: skipLibraries }, () => {
    const data = rows();
    for (const row of [data[0], data[2]]) row.splice(5, 0, null, null, null);
    const book = workbook([['Другой лист']], 'Первый');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(data), 'price_analyse_result');
    assert.equal(calculate(book).meta.detected_columns.orders, 'I');
    const ambiguous = rows(); ambiguous[0].push('Заказов АДЕО');
    assert.throws(() => calculate(workbook(ambiguous)), /однозначно/);
    assert.throws(() => calculate(workbook([['Нет заголовков']])), /Не найдены столбцы/);
    const formula = workbook(rows()); formula.Sheets.price_analyse_result.E3 = { t: 'n', f: '1+1' };
    assert.equal(calculate(formula).meta.skipped_rows, 1);
});

test('Необработанные бренды: служебный заголовок исключается, реальные ошибки не участвуют в суммах', { skip: skipLibraries }, () => {
    const data = rows();
    data.push(['Не найдены бренды: Bosch; бренд', ' БРЕНД ', 'Bosch', 'Brand X\nBrand Y', 'Бренд X', 'Brand Y', 'Brand Z']);
    const result = calculate(workbook(data));
    assert.deepEqual(result.result, calculate(workbook(rows())).result);
    assert.equal(result.meta.warning_count, 0);
    assert.equal(result.meta.skipped_rows, 0);
    assert.equal(result.meta.unprocessed_brand_count, 5);
    assert.deepEqual(result.errors, [{ code: 'UNPROCESSED_BRANDS', row: 4, brands: ['Bosch', 'Brand X', 'Brand Y', 'Бренд X', 'Brand Z'] }]);
    const headerOnly = rows(); headerOnly.push(['Не найдены бренды: ', ' Бренд ', 'BRAND', 'брэнд', 'фирма', 'производитель',
        'марка', 'изготовитель', 'Manufacturer', 'BRAND_NAME', 'Торговая\u00a0марка', 'Производитель:', 'Бренд / производитель']);
    assert.deepEqual(calculate(workbook(headerOnly)).errors, []);
});

test('Предоставленный Excel: итоги совпадают с оригинальным Python-обработчиком ARM', {
    skip: skipLibraries || (!existsSync(resolve(__dirname, '../price_relevance_result.xlsx')) && 'Проверка с пользовательским файлом доступна при его наличии')
}, () => {
    const book = XLSX.read(readFileSync(resolve(__dirname, '../price_relevance_result.xlsx')), { type: 'buffer' });
    const result = calculate(book);
    assert.deepEqual(result.result, { rub_sum: '65729', ordered_from_supplier: 7, total_orders: 489, average_percent: '70.34', maximum_rub: '2939189' });
    assert.equal(result.meta.processed_rows, 973);
    assert.equal(result.meta.warning_count, 0);
    assert.deepEqual(result.errors, [], 'В строке 975 находится только служебное слово «Бренд»');
});

test('Автоанализ: прошлый результат, новые задания, фоновые этапы, отмена, повторы и скачивание по желанию', {
    skip: skipLibraries || (!chromium && 'Нужны Playwright и Chrome')
}, async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const browserContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const page = await browserContext.newPage();
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        let state = { message: 'Файл сформирован. <a href="/admin/admin_pricerelevance/download">Загрузить</a>', inProcess: false };
        let downloads = 0, upload, heldDownload, holdDownload = false, failDownload = false, uploadReply = null;
        let externalRequests = 0;
        const data = rows();
        for (let i = 1; i < 1000; i++) data.push(['B', String(i), 'Товар', 3, 10, 2, 12]);
        data.push(['B', 'bad', 'Ошибка', 1, 10, 2, 'ошибка']);
        data.push(['Не найдены бренды: ', 'Бренд', 'BRAND-X']);
        const bytes = Buffer.from(XLSX.write(workbook(data), { type: 'buffer', bookType: 'xlsx' }));
        await browserContext.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.host !== 'admin.adeo.pro') { externalRequests++; return route.abort('blockedbyclient'); }
            if (url.pathname.endsWith('/state')) return route.fulfill({ json: state });
            if (url.pathname.endsWith('/download')) {
                downloads++;
                if (holdDownload) { heldDownload = route; return; }
                return route.fulfill({ status: failDownload ? 503 : 200, body: bytes, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            }
            if (url.pathname.endsWith('/list')) {
                if (route.request().method() === 'POST') {
                    upload = route;
                    if (uploadReply === null) state = { message: 'Начата обработка файла', inProcess: true };
                    return route.fulfill({ json: uploadReply ?? state.message });
                }
                const html = readFileSync(resolve(__dirname, process.env.ADEO_ANALYSIS_SAVED_PAGE ? '../Администрирование.html' : 'fixtures/pricerelevance.html'), 'utf8')
                    .replaceAll('./Администрирование_files/', '/fixtures/');
                return route.fulfill({ contentType: 'text/html', body: html });
            }
            if (url.pathname.startsWith('/fixtures/')) {
                const name = basename(decodeURIComponent(url.pathname));
                try { return await route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : 'application/javascript', body: readFileSync(resolve(__dirname, '../Администрирование_files', name)) }); }
                catch { return route.fulfill({ status: 404, body: '' }); }
            }
            return route.fulfill({ status: 404, body: '' });
        });
        // Замедляем первый запуск и чтение в отдельном потоке, не подменяя настоящие библиотеки.
        const delay = 'const readyAt = Date.now()+2200; while(Date.now()<readyAt) {}\n;';
        const readDelay = '\n;const originalRead = XLSX.read; XLSX.read = function(...args) { const end = Date.now()+350; while(Date.now()<end) {} return originalRead(...args); };\n;';
        const slowSource = source.replace('getRelevanceWorkerSources(),',
            `((window.analysisWorkerCount = (window.analysisWorkerCount || 0) + 1) === 1 ? ${JSON.stringify(delay)} : ''), getRelevanceWorkerSources(), ${JSON.stringify(readDelay)},`);
        await page.addInitScript({ content: slowSource.replace('    installLoadingProgress();', '    window.analysisDebug = { relevanceAnalysis, relevanceProgress };\n    installLoadingProgress();') });
        await page.goto('https://admin.adeo.pro/admin/admin_pricerelevance/list');
        await page.waitForFunction(() => document.querySelector('.adeo-relevance-bar')?.dataset.stage === 'done');
        assert.match(await page.locator('.adeo-relevance-title').innerText(), /Предыдущий/);
        assert.equal(downloads, 0, 'При открытии страницы прошлый Excel не запрашивается');
        assert.equal(await page.locator('.adeo-analysis-start').isVisible(), true);
        const downloadBox = await page.locator('.adeo-relevance-links a').boundingBox();
        const analyzeBox = await page.locator('.adeo-analysis-start').boundingBox();
        assert.ok(analyzeBox.x >= downloadBox.x + downloadBox.width);
        assert.ok(Math.abs(analyzeBox.y + analyzeBox.height / 2 - downloadBox.y - downloadBox.height / 2) < 1);
        async function poll(message = 'Файл сформирован. <a href="/admin/admin_pricerelevance/download">Загрузить</a>', inProcess = false) {
            state = { message, inProcess }; await page.evaluate(() => window.refreshJobState());
        }
        await poll(); await page.waitForTimeout(100);
        assert.equal(downloads, 0, 'Повторный статус прошлого результата также не запускает анализ');
        await page.locator('input[name=price]').setInputFiles({ name: 'Новый прайс.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('прайс') });
        await page.locator('#submitButton').click();
        await page.waitForFunction(() => document.querySelector('.adeo-relevance-bar').dataset.stage === 'processing');
        assert.ok(upload);
        await poll();
        await page.waitForFunction(() => ['loading', 'error'].includes(document.querySelector('.adeo-relevance-bar').dataset.analysisPhase), null, { timeout: 5000 }).catch(async () => {
            throw new Error(JSON.stringify(await page.evaluate(() => ({ phase: window.analysisDebug.relevanceAnalysis.phase,
                armed: window.analysisDebug.relevanceAnalysis.armed, accepted: window.analysisDebug.relevanceAnalysis.accepted,
                stage: window.analysisDebug.relevanceProgress.stage, message: document.querySelector('.adeo-relevance-message').textContent }))) + `; запросов Excel: ${downloads}; ошибки: ${errors}`);
        });
        assert.equal(await page.locator('.adeo-relevance-bar').getAttribute('data-analysis-phase'), 'loading', await page.locator('.adeo-relevance-message').innerText());
        assert.equal(downloads, 1);
        assert.equal(await page.locator('#submitButton').isDisabled(), true);
        await poll(); await page.waitForTimeout(100);
        assert.equal(downloads, 1, 'Опрос не должен повторно получать и анализировать один результат');
        await page.locator('.adeo-relevance-toggle').click();
        assert.equal(await page.locator('.adeo-relevance-settings').isVisible(), true, 'Интерфейс отвечает во время фонового анализа');
        await page.waitForFunction(() => /Анализ: [1-9]/.test(document.querySelector('.adeo-relevance-time').textContent));
        assert.match(await page.locator('.adeo-relevance-time').innerText(), /Анализ: [1-9]/);
        await page.waitForFunction(() => document.querySelector('.adeo-relevance-bar').dataset.analysisPhase === 'reading');
        await page.waitForFunction(() => document.querySelector('.adeo-relevance-bar').dataset.analysisPhase === 'done');
        assert.deepEqual(await page.locator('.adeo-analysis-grid strong').allTextContents(), ['20 000 ₽', '1 000', '1 001', '-20,00%', '20 000 ₽']);
        assert.match(await page.locator('.adeo-analysis-results').innerText(), /Пропущено строк: 1/);
        assert.match(await page.locator('.adeo-analysis-warnings summary').innerText(), /Предупреждений: 1/);
        assert.equal(await page.locator('.adeo-relevance-title').innerText(), 'Анализ завершён');
        assert.equal(await page.locator('.adeo-analysis-brands').getAttribute('open'), null);
        assert.equal(await page.locator('.adeo-analysis-brands p').isVisible(), false);
        assert.equal(await page.locator('.adeo-analysis-brands summary').innerText(), 'Неизвестные бренды: 1');
        await page.locator('.adeo-analysis-brands summary').click();
        assert.equal(await page.locator('.adeo-analysis-brands p').innerText(), 'BRAND-X');
        assert.doesNotMatch(await page.locator('.adeo-analysis-brands').innerText(), /Строка \d+/);
        assert.doesNotMatch(await page.locator('.adeo-analysis-brands').innerText(), /Бренд/);
        await page.locator('.adeo-analysis-brands summary').click();
        const repeatBox = await page.locator('.adeo-analysis-start').boundingBox();
        const readyDownloadBox = await page.locator('.adeo-relevance-links a').boundingBox();
        assert.ok(repeatBox.x >= readyDownloadBox.x + readyDownloadBox.width);
        assert.match(await page.locator('.adeo-relevance-links a').getAttribute('href'), /^blob:/);
        assert.equal(await page.locator('.adeo-relevance-links a').getAttribute('download'), 'price_relevance_result.xlsx');
        await poll(); await page.waitForTimeout(100);
        assert.equal(downloads, 1);
        if (process.env.ADEO_ANALYSIS_SCREENSHOT) await page.screenshot({ path: process.env.ADEO_ANALYSIS_SCREENSHOT, fullPage: true });
        await page.locator('.adeo-analysis-start').click();
        await page.waitForFunction(() => document.querySelector('.adeo-relevance-bar').dataset.analysisPhase === 'done');
        assert.equal(downloads, 1, 'Повторный анализ использует уже полученный файл');

        // Новое задание очищает старые итоги. Отмена не мешает скачать готовый Excel.
        holdDownload = true;
        await page.locator('#submitButton').click();
        await page.waitForFunction(() => document.querySelector('.adeo-relevance-bar').dataset.stage === 'processing');
        await poll();
        await page.waitForFunction(() => document.querySelector('.adeo-relevance-bar').dataset.analysisPhase === 'downloading');
        assert.equal(await page.locator('.adeo-analysis-results').isVisible(), false);
        await page.locator('.adeo-analysis-cancel').click();
        assert.equal(await page.locator('#submitButton').isDisabled(), false);
        await heldDownload.fulfill({ body: bytes });
        assert.match(await page.locator('.adeo-relevance-message').innerText(), /остановлен/);
        holdDownload = false; failDownload = true;
        await page.locator('.adeo-analysis-start').click();
        await page.waitForFunction(() => document.querySelector('.adeo-relevance-message').textContent.includes('503'));
        assert.equal(await page.locator('.adeo-relevance-links a').getAttribute('href'), 'https://admin.adeo.pro/admin/admin_pricerelevance/download');
        failDownload = false;
        await page.locator('.adeo-analysis-start').click();
        await page.waitForFunction(() => document.querySelector('.adeo-relevance-bar').dataset.analysisPhase === 'done');
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        // В другой открытой вкладке готовый результат остаётся прошлым до ручного запуска.
        const beforeManual = downloads;
        const otherPage = await browserContext.newPage();
        await otherPage.addInitScript({ content: source });
        await otherPage.goto('https://admin.adeo.pro/admin/admin_pricerelevance/list');
        await otherPage.waitForFunction(() => document.querySelector('.adeo-relevance-bar')?.dataset.stage === 'done');
        assert.equal(downloads, beforeManual);
        await otherPage.locator('.adeo-analysis-start').click();
        await otherPage.waitForFunction(() => document.querySelector('.adeo-relevance-bar').dataset.analysisPhase === 'done');
        assert.equal(downloads, beforeManual + 1);
        assert.match(await otherPage.locator('.adeo-analysis-results h3').innerText(), /предыдущего/);
        await otherPage.close();
        // Пустое подтверждение POST и старый готовый статус не доказывают появление нового результата.
        const beforeUnconfirmed = downloads;
        uploadReply = '';
        await page.locator('#submitButton').click();
        await page.waitForFunction(() => document.querySelector('.adeo-relevance-bar').dataset.stage === 'queued');
        await poll();
        await page.waitForFunction(() => document.querySelector('.adeo-relevance-bar').dataset.stage === 'done');
        assert.equal(downloads, beforeUnconfirmed);
        await poll('Обработано 500 строк из 1001', true);
        await page.waitForFunction(() => document.querySelector('.adeo-relevance-bar').dataset.stage === 'processing');
        await poll();
        await page.waitForFunction(() => document.querySelector('.adeo-relevance-bar').dataset.analysisPhase === 'done');
        assert.equal(downloads, beforeUnconfirmed + 1);
        assert.equal(externalRequests, 0, 'Анализ должен работать при полной блокировке внешних библиотек');
        assert.deepEqual(errors, []);
        await browserContext.close();
    } finally { await browser.close(); }
});
