const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve, basename } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(resolve(__dirname, '../adeo.user.js'), 'utf8');
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* Без браузера остаётся проверка разбора статусов. */ }

test('Статусы анализа: строки, подготовка, завершение, очередь и ошибки', () => {
    const context = vm.createContext({
        window: { location: { pathname: '/test' } }, document: { readyState: 'loading', addEventListener() {} }
    });
    vm.runInContext(source.replace(
        '    installRelevanceProgress();', '    globalThis.parseStatus = parseRelevanceStatus; globalThis.decodeMessage = decodeRelevanceMessage;\n    installRelevanceProgress();'
    ), context);
    const encoded = String.raw`"\u041d\u0430\u0447\u0430\u0442\u0430 \u043e\u0431\u0440\u0430\u0431\u043e\u0442\u043a\u0430 \u0444\u0430\u0439\u043b\u0430"`;
    assert.equal(context.decodeMessage(encoded), 'Начата обработка файла');
    assert.equal(context.parseStatus(context.decodeMessage(encoded)).stage, 'processing');
    for (const message of ['Обычный текст', '<a href="/download">Загрузить</a>', '"Незакрытая строка', '123', '{"state":1}']) {
        assert.equal(context.decodeMessage(message), message);
    }
    for (const [message, stage, percent] of [
        ['', 'idle', null],
        ['Файл сохранен, ожидается обработка', 'queued', null],
        ['Начата обработка файла', 'processing', null],
        ['Обработано 100 строк из 3233', 'processing', 100 / 3233 * 100],
        ['Обработано 1 000 строк из 2 000', 'processing', 50],
        ['Обработано 0 строк из 0', 'processing', null],
        ['Обработано строк: 3233 Подготовка результата ...', 'preparing', null],
        ['Файл сформирован. Загрузить', 'done', null],
        ['При обработке произошла ошибка: отсутствует столбец', 'error', null],
        ['Новое сообщение сервера', 'unknown', null]
    ]) {
        const result = context.parseStatus(message);
        assert.equal(result.stage, stage, message);
        assert.equal(result.percent, percent, message);
    }
});

test('Анализ прайса: настройки, перетаскивание, один запрос, этапы, ошибки и результат', {
    skip: !chromium && 'Нужны Playwright и Chrome'
}, async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        let status = { message: '', inProcess: false };
        let pollFailure = false;
        let upload;
        let posts = 0;
        let payload = '';
        let heldPoll;
        let holdNextPoll = false;
        const html = readFileSync(resolve(__dirname, process.env.ADEO_RELEVANCE_SAVED_PAGE ? '../Администрирование.html' : 'fixtures/pricerelevance.html'), 'utf8')
            .replaceAll('./Администрирование_files/', '/fixtures/');
        await page.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.pathname === '/admin/admin_pricerelevance/state') {
                if (holdNextPoll) { holdNextPoll = false; heldPoll = route; return; }
                return route.fulfill({ status: pollFailure ? 503 : 200, json: status });
            }
            if (url.pathname === '/admin/admin_pricerelevance/list') {
                if (route.request().method() === 'POST') {
                    posts++; payload = route.request().postDataBuffer().toString(); upload = route; return;
                }
                return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
            }
            if (url.pathname.startsWith('/fixtures/')) {
                const name = basename(decodeURIComponent(url.pathname));
                const type = name.endsWith('.css') ? 'text/css' : /\.js/.test(name) ? 'application/javascript' : 'application/octet-stream';
                try {
                    return await route.fulfill({ contentType: type, body: readFileSync(resolve(__dirname, '../Администрирование_files', name)) });
                } catch { return route.fulfill({ status: 404, body: '' }); }
            }
            return route.fulfill({ status: 404, body: '' });
        });
        await page.addInitScript({ content: source });
        await page.goto('https://admin.adeo.pro/admin/admin_pricerelevance/list');
        await page.waitForSelector('.adeo-relevance-bar');
        await page.waitForFunction(() => document.querySelector('.adeo-relevance-bar').dataset.stage === 'idle');
        assert.equal(await page.locator('#submitButton').isDisabled(), true);
        assert.equal(await page.locator('.adeo-relevance-settings').isVisible(), false);
        assert.equal(await page.locator('[name=outStart]').inputValue(), '5');
        assert.equal(await page.locator('[name=orders_avg_cost]').isChecked(), false);
        assert.equal(await page.locator('[name=orders_max_cost]').isChecked(), false);
        assert.match(await page.locator('[name=start_date]').inputValue(), /^\d{4}-\d{2}-\d{2}$/);
        await page.locator('.adeo-relevance-toggle').click();
        await page.locator('[name=outStart]').fill('9');
        await page.locator('[name=start_date]').fill('2025-01-15');
        await page.locator('label[for=adeo-relevance-orders_avg_cost]').click();
        assert.equal(await page.locator('[name=orders_avg_cost]').isChecked(), true);
        if (process.env.ADEO_RELEVANCE_SCREENSHOT) await page.screenshot({ path: process.env.ADEO_RELEVANCE_SCREENSHOT.replace('.png', '-settings.png'), fullPage: true });
        await page.locator('.adeo-relevance-toggle').click();

        async function drop(names) {
            return page.evaluate(names => {
                const dataTransfer = new DataTransfer();
                names.forEach(name => dataTransfer.items.add(new File(['пример файла'], name)));
                document.body.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer }));
                const visible = !document.querySelector('.adeo-relevance-drop').hidden;
                const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer });
                document.body.dispatchEvent(event);
                return { visible, prevented: event.defaultPrevented };
            }, names);
        }
        assert.deepEqual(await drop(['Прайс.xlsx']), { visible: true, prevented: true });
        assert.equal(await page.locator('.adeo-file-name').innerText(), 'Прайс.xlsx');
        assert.equal(posts, 0, 'Выбор файла не запускает обработку');
        await drop(['a.xls', 'b.xlsx']);
        assert.match(await page.locator('.adeo-file-error').innerText(), /один/);
        assert.equal(await page.locator('.adeo-file-name').innerText(), 'Прайс.xlsx');
        await drop(['ошибка.txt']);
        assert.match(await page.locator('.adeo-file-error').innerText(), /XLS/);
        await drop(['Прайс.xlsx']);

        // Ответ старого опроса не должен завершать новую проверку.
        holdNextPoll = true;
        await page.evaluate(() => window.refreshJobState());
        await page.waitForTimeout(40);
        await page.locator('#submitButton').click();
        await page.waitForFunction(() => document.querySelector('.adeo-relevance-bar').dataset.stage === 'uploading');
        assert.equal(posts, 1);
        assert.match(payload, /name="price"; filename=/);
        assert.match(payload, /name="outStart"\r\n\r\n9/);
        assert.match(payload, /name="start_date"\r\n\r\n2025-01-15/);
        await heldPoll.fulfill({ json: { message: 'Файл сформирован. Старый результат', inProcess: false } });
        assert.equal(await page.locator('#submitButton').isDisabled(), true);
        await drop(['Другой.xls']);
        assert.equal(await page.locator('.adeo-file-name').innerText(), 'Прайс.xlsx');
        await page.locator('#price-form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
        assert.equal(posts, 1, 'Повторная отправка заблокирована');
        status = { state: 0, message: 'Файл сохранен, ожидается обработка', inProcess: false };
        await upload.fulfill({ body: status.message });
        await page.waitForFunction(() => document.querySelector('.adeo-relevance-bar').dataset.stage === 'queued');
        async function poll(message, inProcess, stage) {
            status = { message, inProcess };
            await page.evaluate(() => window.refreshJobState());
            await page.waitForFunction(stage => document.querySelector('.adeo-relevance-bar').dataset.stage === stage, stage);
        }
        await poll('Файл сохранен, ожидается обработка', false, 'queued');
        assert.equal(await page.locator('#submitButton').isDisabled(), true, 'Очередь остаётся активной даже при inProcess=false');
        await poll('Начата обработка файла', true, 'processing');
        await poll('Обработано 100 строк из 3233', true, 'processing');
        await page.waitForFunction(() => document.querySelector('[role=progressbar]').getAttribute('aria-valuenow') === '3');
        assert.match(await page.locator('.adeo-relevance-message').innerText(), /100 строк из 3233/);
        if (process.env.ADEO_RELEVANCE_SCREENSHOT) await page.screenshot({ path: process.env.ADEO_RELEVANCE_SCREENSHOT.replace('.png', '-processing.png'), fullPage: true });
        pollFailure = true;
        await page.evaluate(() => window.refreshJobState());
        await page.waitForFunction(() => document.querySelector('.adeo-relevance-warning').textContent.includes('503'));
        assert.equal(await page.locator('#submitButton').isDisabled(), true);
        pollFailure = false;
        await poll('Обработано строк: 3233 Подготовка результата ...', true, 'preparing');
        assert.equal(await page.locator('.adeo-relevance-warning').innerText(), '');
        assert.equal(await page.locator('[role=progressbar]').getAttribute('aria-valuenow'), null);
        if (process.env.ADEO_RELEVANCE_SCREENSHOT) await page.screenshot({ path: process.env.ADEO_RELEVANCE_SCREENSHOT, fullPage: true });
        await poll('Файл сформирован. <a href="/admin/admin_pricerelevance/download">Загрузить</a>', false, 'done');
        await page.waitForFunction(() => document.querySelector('.adeo-relevance-bar').dataset.analysisPhase === 'error');
        assert.equal(await page.locator('.adeo-relevance-links a').getAttribute('href'), 'https://admin.adeo.pro/admin/admin_pricerelevance/download');
        assert.equal(await page.locator('#submitButton').isDisabled(), false);
        assert.equal(await page.locator('[name=outStart]').inputValue(), '9');
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (process.env.ADEO_RELEVANCE_SCREENSHOT) await page.screenshot({ path: process.env.ADEO_RELEVANCE_SCREENSHOT.replace('.png', '-mobile.png'), fullPage: true });
        assert.equal(await page.locator('.adeo-relevance-bar').count(), 1);
        await poll('При обработке произошла ошибка: Hачальный столбец является необходимым параметром.', false, 'error');
        assert.equal(await page.locator('#submitButton').isDisabled(), false);
        await page.locator('.adeo-file-remove').click();
        assert.equal(await page.locator('#submitButton').isDisabled(), true);
        await drop(['Следующий.xlsx']);
        await page.locator('#submitButton').click();
        await page.waitForFunction(() => document.querySelector('.adeo-relevance-bar').dataset.stage === 'uploading');
        assert.equal(posts, 2);
        await upload.fulfill({ status: 500, body: 'Ошибка сервера' });
        await page.waitForFunction(() => document.querySelector('.adeo-relevance-bar').dataset.stage === 'error');
        assert.match(await page.locator('.adeo-relevance-message').innerText(), /HTTP 500/);
        // Проверяем настоящий формат POST /list: JSON-строка вместо объекта состояния.
        for (const [message, stage] of [
            ['Начата обработка файла', 'processing'],
            ['Файл сохранен, ожидается обработка', 'queued'],
            ['При обработке произошла ошибка: неверный столбец', 'error'],
            ['Файл сформирован. <a href="/admin/admin_pricerelevance/download">Загрузить</a>', 'done']
        ]) {
            await page.locator('#submitButton').click();
            await page.waitForFunction(() => document.querySelector('.adeo-relevance-bar').dataset.stage === 'uploading');
            const encoded = JSON.stringify(message).replace(/[^\x00-\x7f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
            await upload.fulfill({ contentType: 'application/json', body: encoded });
            await page.waitForFunction(stage => document.querySelector('.adeo-relevance-bar').dataset.stage === stage, stage);
            if (stage === 'done') {
                await page.waitForFunction(() => document.querySelector('.adeo-relevance-bar').dataset.analysisPhase === 'error');
                assert.match(await page.locator('.adeo-relevance-message').innerText(), /HTTP 404/);
            } else assert.equal(await page.locator('.adeo-relevance-message').innerText(), message.replace(/<[^>]*>/g, ''));
            assert.equal(await page.locator('#submitButton').isDisabled(), ['processing', 'queued'].includes(stage));
            if (stage === 'done') assert.equal(await page.locator('.adeo-relevance-links a').getAttribute('href'), 'https://admin.adeo.pro/admin/admin_pricerelevance/download');
            // Завершаем задание штатным опросом, чтобы проверить следующий вариант ответа.
            await poll('Файл сформирован.', false, 'done');
        }
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});
