const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { resolve, basename } = require('node:path');
const vm = require('node:vm');
const XLSX = require('../assets/vendor/xlsx-0.20.3.js');
const Decimal = require('../assets/vendor/decimal-10.6.0.js');
const source = readFileSync(resolve(__dirname, '../adeo.user.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.replace('    installLoadingProgress();', '    globalThis.calculate = calculateMarketabilityWorkbook; return;'), context);
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* Браузерные проверки требуют Playwright и Chrome. */ }

const headers = ['Позиция', 'Всего позиция', 'Цена', 'Лучшая цена/(Ближайшая)', 'Поставщик', 'Наличие', 'Разница, %', 'Артикул', 'Бренд', 'Наименование'];
const position = (rank, id = '1') => [rank, 5, 100, 100, 'CellaTEST/3', 3, 0, id, 'Бренд', 'Товар'];
function book(rows) {
    const result = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(result, XLSX.utils.aoa_to_sheet(rows), 'tempfile_test'); return result;
}
function calculate(rows) { return JSON.parse(JSON.stringify(context.calculate(book(rows), XLSX, Decimal))); }

test('Конкурентоспособность: уникальные позиции отделены от топ-1, служебная строка не считается', () => {
    const data = [headers, position(1), position(2), position(3), position(4), ['Уникальные позиции'], position(1), position(1)];
    const result = calculate(data);
    assert.deepEqual(result.result, { top1: 1, unique: 2, top2: 1, top3: 1, total: 6, percent: '50.00', passed: 3,
        target: 30, meetsTarget: true, discountRows: null, removeRows: null });
    data[6][0] = data[7][0] = 999;
    assert.deepEqual(calculate(data).result, result.result, 'Файл после макроса даёт те же итоги');
    assert.equal(calculate([headers, position(999), position(1)]).result.unique, 1);
});

test('Порог ровно 30%, округление количества строк вверх и неверные позиции', () => {
    const data = [headers, ...Array.from({ length: 10 }, (_, i) => position(i < 2 ? 1 : 4, String(i)))];
    assert.deepEqual(calculate(data).result, { top1: 2, unique: 0, top2: 0, top3: 0, total: 10, percent: '20.00', passed: 2,
        target: 30, meetsTarget: false, discountRows: 1, removeRows: 4 });
    data[3][0] = 1;
    assert.equal(calculate(data).result.percent, '30.00');
    assert.equal(calculate(data).result.discountRows, null);
    assert.equal(calculate(data).result.removeRows, null);
    const invalid = calculate([headers, position('нет'), position(' 1 '), [], ['Примечание']]);
    assert.equal(invalid.result.total, 2);
    assert.equal(invalid.meta.invalidRows, 1);
    assert.throws(() => calculate([['Другая книга'], [1]]), /Не найдена таблица/);
    assert.throws(() => calculate([headers]), /не найдены позиции/);
});

test('Исходный отчёт CRM совпадает с восемью показателями O1:V2 после макроса', {
    skip: !existsSync(resolve(__dirname, '../Отчет конкурентноспособности.xlsx')) || !existsSync(resolve(__dirname, '../после макроса - Отчет конкурентноспособности.xlsx'))
}, () => {
    const original = XLSX.read(readFileSync(resolve(__dirname, '../Отчет конкурентноспособности.xlsx')), { type: 'buffer', cellFormula: false, cellText: false });
    const result = context.calculate(original, XLSX, Decimal).result;
    const expected = XLSX.read(readFileSync(resolve(__dirname, '../после макроса - Отчет конкурентноспособности.xlsx')), { type: 'buffer', sheetRows: 2 });
    const sheet = expected.Sheets[expected.SheetNames[0]];
    assert.deepEqual([result.top1, result.unique, result.top2, result.top3, result.total, result.percent, result.discountRows, result.removeRows],
        [sheet.O2.v, sheet.P2.v, sheet.Q2.v, sheet.R2.v, sheet.S2.v, new Decimal(sheet.T2.v).times(100).toFixed(2), sheet.U2.v, sheet.V2.v]);
});

function row(id, ready = true, signature = 'initial') {
    return `<tr data-report="${id}"><td>${ready ? 'Готов' : 'В очереди'}</td><td>20 нояб. 10:00</td><td>Прайс Cella${id}/3</td><td>${ready ? `<a download href="https://s3.adeo.pro/crm-bucket-1d/report-${id}?Signature=${signature}">Скачать</a>` : '<span class="native-cancel full-width"><button type="button" aria-label="Отменить задание">×</button></span>'}</td></tr>`;
}
const fixture = `<style>body{margin:0;font:14px Arial}.marketability{display:flex;flex-direction:column;height:100vh}.marketability__row{display:flex}.marketability__col{width:50%}table{border-collapse:collapse}td,th{padding:12px}button,input{font:inherit}.q-table__middle{overflow:auto}</style>
<div class="marketability"><form><h2>Параметры генерации отчета</h2><div class="marketability__row"><div class="marketability__col">Поставщик <input aria-label="Прайс" value="CellaTEST/3"></div><div class="marketability__col">Позиции c <input aria-label="c" value="1"> до <input aria-label="до" value="998"></div></div><div class="marketability__row"><label><input type="checkbox" name="unique">Уникальные позиции</label></div><div class="full-width"><button type="submit">Добавить в очередь</button></div></form>
<div class="marketability__log"><div class="q-table__title">Состояние очереди заданий</div><div class="q-table__middle"><table class="q-table"><thead><tr><th>Статус</th><th>Добавлен</th><th>Параметры</th><th>Отчёт</th></tr></thead><tbody class="q-virtual-scroll__content">${row(1)}${row(2)}${row(3, false)}</tbody></table></div></div></div>`;

test('CRM: только ручной анализ, отдельные результаты, отмена, срок ссылки, обновление таблицы и переходы SPA', {
    skip: !chromium && 'Нужны Playwright и Chrome'
}, async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        const page = await browserContext.newPage(); const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        let requests = [], downloads = 0, held, hold = true, expired = true, external = 0;
        page.on('download', () => downloads++);
        const files = {
            1: Buffer.from(XLSX.write(book([headers, position(1), position(1), ...Array.from({ length: 7 }, (_, i) => position(4, String(i))), ['Уникальные позиции'], position(1)]), { type: 'buffer', bookType: 'xlsx' })),
            2: Buffer.from(XLSX.write(book([headers, position(1), ...Array.from({ length: 7 }, (_, i) => position(4, String(i)))]), { type: 'buffer', bookType: 'xlsx' }))
        };
        await browserContext.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.host === 'crm.adeo.pro') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture });
            if (url.host === 's3.adeo.pro') {
                requests.push(url.href);
                assert.equal(route.request().headers().cookie, undefined, 'Подписанной ссылке не нужны cookies CRM');
                if (hold) { held = route; return; }
                if (url.pathname.endsWith('report-2') && expired) return route.fulfill({ status: 403, body: 'Expired' });
                return route.fulfill({ contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: files[url.pathname.endsWith('report-2') ? 2 : 1] });
            }
            external++; return route.abort('blockedbyclient');
        });
        const slowSource = source.replace('function calculateMarketabilityWorkbook(workbook, XLSX, Decimal, progress = () => {}) {',
            'function calculateMarketabilityWorkbook(workbook, XLSX, Decimal, progress = () => {}) { const until = Date.now()+2100; while(Date.now()<until) {}');
        await page.addInitScript({ content: slowSource });
        await page.goto('https://crm.adeo.pro/reports/marketability/');
        await page.waitForSelector('.adeo-marketability-launch');
        await page.evaluate(() => {
            window.queueSubmits = 0;
            document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); window.queueSubmits++; });
        });
        const first = page.locator('[data-report="1"]'), second = page.locator('[data-report="2"]'), pending = page.locator('[data-report="3"]');
        assert.equal(requests.length, 0);
        assert.equal(await pending.locator('.adeo-marketability-launch').isDisabled(), true);
        const actionBounds = target => target.locator('td:last-child').evaluate(cell => {
            const native = cell.querySelector(':scope > :not(.adeo-marketability-launch)').getBoundingClientRect();
            const analysis = cell.querySelector('.adeo-marketability-launch').getBoundingClientRect();
            const bounds = cell.getBoundingClientRect();
            return { left: native.left - bounds.left, right: analysis.left - bounds.left, width: analysis.width,
                nativeCenterY: native.top + native.height / 2, analysisCenterY: analysis.top + analysis.height / 2 };
        });
        const pendingBounds = await actionBounds(pending);
        assert.ok(pendingBounds.right >= pendingBounds.left + 36);
        assert.ok(Math.abs(pendingBounds.nativeCenterY - pendingBounds.analysisCenterY) < 1);
        await pending.locator('td:last-child').evaluate(cell => {
            window.nativeCancels = 0;
            cell.querySelector('.native-cancel button').addEventListener('click', () => window.nativeCancels++);
        });
        await pending.getByRole('button', { name: 'Отменить задание' }).click();
        assert.equal(await page.evaluate(() => window.nativeCancels), 1);
        // Воспроизводим патч Vue: готовая ссылка появляется ПОСЛЕ уже существующей кнопки анализа.
        await pending.locator('td:last-child').evaluate(cell => {
            cell.querySelector('.native-cancel').remove();
            const link = document.createElement('a'); link.download = ''; link.textContent = '↓';
            link.href = 'https://s3.adeo.pro/crm-bucket-1d/report-3?Signature=ready'; cell.append(link);
        });
        await page.waitForFunction(() => !document.querySelector('[data-report="3"] .adeo-marketability-launch').disabled);
        const readyBounds = await actionBounds(pending);
        assert.ok(Math.abs(readyBounds.left - pendingBounds.left) < 1);
        assert.ok(Math.abs(readyBounds.right - pendingBounds.right) < 1);
        assert.ok(Math.abs(readyBounds.nativeCenterY - readyBounds.analysisCenterY) < 1);
        assert.equal(requests.length, 0, 'Переход в готовность не должен запускать анализ');
        const originalHref = await first.locator('a').getAttribute('href');
        await first.locator('button').click();
        await page.waitForFunction(() => document.querySelector('.adeo-marketability-result')?.dataset.phase === 'downloading');
        await page.waitForTimeout(100);
        assert.equal(requests.length, 1);
        assert.equal(await second.locator('button').isDisabled(), true);
        await page.getByRole('button', { name: 'Остановить анализ', exact: true }).click();
        await held.fulfill({ body: files[1] }); hold = false;
        assert.match(await page.locator('.adeo-marketability-status').innerText(), /остановлен/);
        await page.getByRole('button', { name: 'Повторить анализ', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.adeo-marketability-result').dataset.phase === 'calculating');
        await page.locator('[aria-label="c"]').fill('2');
        await page.getByRole('button', { name: 'Добавить в очередь' }).click();
        assert.equal(await page.evaluate(() => window.queueSubmits), 1);
        await page.waitForFunction(() => /Время анализа: [1-9]/.test(document.querySelector('.adeo-marketability-time').textContent));
        await page.getByRole('button', { name: 'Остановить анализ', exact: true }).click();
        const cachedRequests = requests.length;
        await page.getByRole('button', { name: 'Повторить анализ', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.adeo-marketability-result').dataset.phase === 'done');
        assert.equal(requests.length, cachedRequests);
        assert.deepEqual(await page.locator('.adeo-marketability-metric strong').allTextContents(), ['2', '1', '0', '0', '10', '30,00%', '—', '—']);
        assert.equal(await first.locator('a').getAttribute('href'), originalHref);
        const resultBounds = await actionBounds(first);
        assert.ok(Math.abs(resultBounds.nativeCenterY - resultBounds.analysisCenterY) < 1);
        assert.equal(resultBounds.width, readyBounds.width, 'Длина надписи не должна менять место кнопки');
        await second.locator('button').click();
        await page.waitForFunction(() => [...document.querySelectorAll('.adeo-marketability-result')].some(panel => panel.dataset.phase === 'error'));
        assert.match(await page.locator('.adeo-marketability-result[data-phase=error]').innerText(), /срок её действия истёк/);
        expired = false;
        await second.locator('a').evaluate(a => { a.href = a.href.replace('initial', 'renewed'); });
        await page.waitForTimeout(100);
        await page.locator('.adeo-marketability-result[data-phase=error]').getByRole('button', { name: 'Повторить анализ' }).click();
        await page.waitForFunction(() => [...document.querySelectorAll('.adeo-marketability-result[data-phase=done]')].length === 2);
        assert.match(requests.at(-1), /Signature=renewed/);
        const secondPanel = page.locator('.adeo-marketability-detail').nth(1);
        assert.deepEqual(await secondPanel.locator('.adeo-marketability-metric strong').allTextContents(), ['1', '0', '0', '0', '8', '12,50%', '2', '5']);
        if (process.env.ADEO_MARKETABILITY_SCREENSHOT) await page.screenshot({ path: process.env.ADEO_MARKETABILITY_SCREENSHOT, fullPage: true });
        // Виртуальная таблица может использовать существующую строку для другого отчёта.
        await first.locator('a').evaluate(a => { a.href = a.href.replace('report-1', 'report-4'); });
        await page.waitForFunction(() => document.querySelector('[data-report="1"] button').textContent === 'Анализ');
        assert.equal(await page.locator('.adeo-marketability-detail').count(), 1);
        const beforeRestore = requests.length;
        await page.locator('.q-virtual-scroll__content').evaluate((tbody, html) => { tbody.innerHTML = html; }, row(1) + row(2) + row(3, false));
        await page.waitForFunction(() => document.querySelectorAll('.adeo-marketability-detail').length === 2);
        assert.equal(requests.length, beforeRestore);
        assert.equal(await page.locator('.adeo-marketability-launch').count(), 3);
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.evaluate(() => { history.pushState({}, '', '/supplier/supplier-list'); document.querySelector('.marketability').remove(); });
        await page.waitForTimeout(100);
        await page.evaluate(html => { history.pushState({}, '', '/reports/marketability'); document.body.innerHTML = html; }, fixture);
        await page.waitForSelector('.adeo-marketability-launch');
        assert.equal(await page.locator('.adeo-marketability-detail').count(), 0);
        assert.equal(requests.length, beforeRestore);
        assert.equal(downloads, 0, 'Анализ не должен запускать сохранение Excel пользователю');
        assert.equal(external, 0, 'Встроенные библиотеки не обращаются к CDN');
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('Сохранённая CRM: исходный отчёт 99 907 позиций, реальные стили и видимые параметры формы', {
    skip: !chromium || !existsSync(resolve(__dirname, '../AdeoCRM - платформа управления АДЕОПРО.html')) || !existsSync(resolve(__dirname, '../Отчет конкурентноспособности.xlsx'))
}, async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        const html = readFileSync(resolve(__dirname, '../AdeoCRM - платформа управления АДЕОПРО.html'), 'utf8')
            .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
        let requests = 0;
        await page.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.host === 's3.adeo.pro') { requests++; return route.fulfill({ body: readFileSync(resolve(__dirname, '../Отчет конкурентноспособности.xlsx')) }); }
            const marker = 'AdeoCRM - платформа управления АДЕОПРО_files/';
            const path = decodeURIComponent(url.pathname);
            if (path.includes(marker)) {
                const name = basename(path);
                try { return await route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : 'application/octet-stream', body: readFileSync(resolve(__dirname, '../AdeoCRM - платформа управления АДЕОПРО_files', name)) }); }
                catch { return route.fulfill({ status: 404, body: '' }); }
            }
            if (/\/reports\/marketability\/?$/.test(path)) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
            return route.fulfill({ status: 404, body: '' });
        });
        await page.addInitScript({ content: source });
        await page.goto('https://crm.adeo.pro/reports/marketability');
        await page.waitForSelector('.adeo-marketability-launch');
        assert.equal(requests, 0);
        assert.equal(await page.locator('.marketability [role=switch]').count(), 4);
        assert.equal(await page.locator('.marketability [role=switch]:visible').count(), 4);
        assert.equal(await page.locator('input[aria-label="ID"]').inputValue(), '153893');
        assert.equal(await page.locator('input[aria-label="c"]').inputValue(), '1');
        const layout = await page.locator('.marketability').evaluate(root => {
            const rows = root.querySelectorAll('form .marketability__row');
            const header = root.querySelector('thead th:last-child').getBoundingClientRect();
            const cell = root.querySelector('td.adeo-marketability-report');
            const link = cell.querySelector('a').getBoundingClientRect(), button = cell.querySelector('button').getBoundingClientRect();
            return { formHeight: root.querySelector('form').getBoundingClientRect().height,
                rowTops: [rows[0].getBoundingClientRect().top, rows[3].getBoundingClientRect().top],
                fieldLefts: ['Прайс', 'c', 'ID'].map(label => root.querySelector(`input[aria-label="${label}"]`).closest('.q-field').getBoundingClientRect().left),
                headerCenter: header.x + header.width / 2, actionsCenter: (link.left + button.right) / 2 };
        });
        assert.ok(Math.abs(layout.rowTops[0] - layout.rowTops[1]) < 1, 'Параметры должны располагаться в две колонки');
        assert.ok(Math.max(...layout.fieldLefts) - Math.min(...layout.fieldLefts) < 2, 'Поля основных параметров должны начинаться на одной линии');
        assert.ok(layout.formHeight < 550, 'Компактная форма должна оставлять место для очереди');
        assert.ok(Math.abs(layout.headerCenter - layout.actionsCenter) < 2, 'Действия должны стоять по центру под заголовком');
        await page.setViewportSize({ width: 1920, height: 650 });
        const scrollArea = await page.locator('.marketability').boundingBox();
        const formArea = await page.locator('.marketability > form').boundingBox();
        assert.ok(formArea.x - scrollArea.x > 30, `По бокам карточек должно быть свободное пространство: ${JSON.stringify({ formArea, scrollArea })}`);
        // У сохранённой страницы высоты контейнеров зафиксированы CRM; создаём переполнение для проверки колёсика.
        await page.locator('.marketability').evaluate(root => {
            const spacer = document.createElement('div'); spacer.id = 'scroll-check-spacer'; spacer.style.flex = '0 0 1200px'; root.append(spacer);
        });
        await page.mouse.move(scrollArea.x + 10, scrollArea.y + 100);
        await page.mouse.wheel(0, 450);
        await page.waitForFunction(() => document.querySelector('.marketability').scrollTop > 0);
        await page.locator('.marketability').evaluate(root => { root.querySelector('#scroll-check-spacer').remove(); root.scrollTop = 0; });
        await page.setViewportSize({ width: 1600, height: 1100 });
        if (process.env.ADEO_MARKETABILITY_SCREENSHOT) await page.screenshot({ path: process.env.ADEO_MARKETABILITY_SCREENSHOT.replace('.png', '-form.png'), fullPage: true });
        await page.locator('.adeo-marketability-launch').click();
        await page.waitForFunction(() => document.querySelector('.adeo-marketability-result')?.dataset.phase === 'done');
        assert.deepEqual(await page.locator('.adeo-marketability-metric strong').allTextContents(),
            ['8 385', '5 075', '17 807', '4 817', '99 907', '13,47%', '16 513', '55 041']);
        assert.equal(requests, 1);
        if (process.env.ADEO_MARKETABILITY_SCREENSHOT) await page.screenshot({ path: process.env.ADEO_MARKETABILITY_SCREENSHOT.replace('.png', '-saved.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});
