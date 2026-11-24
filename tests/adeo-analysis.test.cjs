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
vm.runInContext(source.replace('    installLoadingProgress();', '    globalThis.calculate = calculateRelevanceWorkbook; globalThis.workerSources = getRelevanceWorkerSources; globalThis.startDate = getAutoPriceStartDate; return;'), context);
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

test('Периоды продаваемости учитывают дни, календарные месяцы и свою дату', () => {
    const today = new Date(2026, 10, 24);
    assert.equal(context.startDate('30', '', today), '2026-10-25');
    assert.equal(context.startDate('90', '', today), '2026-08-26');
    assert.equal(context.startDate('half-year', '', new Date(2024, 7, 31)), '2024-02-29');
    assert.equal(context.startDate('year', '', new Date(2024, 1, 29)), '2023-02-28');
    assert.equal(context.startDate('custom', '2020-01-15', today), '2020-01-15');
});

test('Кнопка запускает выбранные этапы для одного файла', {
    skip: skipLibraries || (!chromium && 'Нужны Playwright и Chrome')
}, async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const data = rows();
        data.push(['B', '2', 'Ошибка', 1, 10, 2, 'ошибка'], ['Не найдены бренды: ', 'Brand X']);
        const bytes = Buffer.from(XLSX.write(workbook(data), { type: 'buffer', bookType: 'xlsx' }));
        const html = readFileSync(resolve(__dirname, 'fixtures/pricerelevance.html'), 'utf8')
            .replace('<input type="file" name="price">', '<input type="file" name="price"><input type="hidden" name="csrf" value="token">');
        const oldResult = 'Файл сформирован. <a href="/old.xlsx">Загрузить</a>';
        const result = 'Файл сформирован. <a href="/report.xlsx">Загрузить</a>';
        let posts = 0, polls = 0, downloads = 0, oldDownloads = 0, payload;
        let imports = 0, confirmations = 0, importPayload, cellBusy = true;
        let status = 'Файл сохранен, ожидается обработка';
        await page.context().route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.origin === 'https://import.example' && url.pathname === '/confirm') {
                confirmations++;
                assert.equal(url.searchParams.get('token'), 'test+value');
                assert.equal(url.searchParams.get('cb'), 'adeoConfirmTestPriceImport');
                return route.fulfill({ contentType: 'application/javascript', body: 'adeoConfirmTestPriceImport({job_id: 82});' });
            }
            if (url.host !== 'admin.adeo.pro') return route.abort('blockedbyclient');
            if (url.pathname === '/admin/piqueue/cella/inqueue/43068/7') {
                assert.equal(route.request().method(), 'POST');
                return route.fulfill({ json: { job_id: 81 } });
            }
            if (url.pathname === '/admin/piqueue/item/info/81') {
                return route.fulfill({ json: { state: cellBusy ? 2 : 3 } });
            }
            if (url.pathname === '/admin/piqueue/item/info/82') {
                return route.fulfill({ json: { state: 3, info: '<b>Импорт окончен. Строк: 4</b>' } });
            }
            if (url.pathname === '/admin/piqueue/item/log/82') {
                assert.equal(route.request().method(), 'POST');
                if (imports > 1) return route.fulfill({ json: { log: `<table>
                    <tr><td class="gen_td">Импорт окончен. Строк всего: 4</td></tr>
                    <tr><td class="gen_td">Импортировано: 4</td></tr>
                    <tr><td class="gen_td">Нулевые остатки: Нет данных</td></tr>
                </table>` } });
                return route.fulfill({ json: { log: `<table>
                    <tr><td class="gen_td">Импорт окончен. Строк всего: 7 297</td></tr>
                    <tr><td class="gen_td">Импортировано: 6556, с ошибками: 1</td></tr>
                    <tr><td class="gen_td"><details><summary>Отсутствует или неверный артикул: 738</summary><table>
                        <tr><td>0</td><td>Строка 106 отсутствует артикул: образец</td></tr>
                    </table></details></td></tr>
                    <tr><td class="gen_td">Нулевые остатки: 0</td></tr>
                    <tr><td class="gen_td"><details><summary>Неизвестных брендов: 10</summary><table>
                        <tr><td>1</td><td>TEST BRAND</td></tr><tr><td>2</td><td></td></tr>
                    </table></details></td></tr>
                </table>` } });
            }
            if (url.pathname === '/admin/supplier/price/comparemode/43068/7') {
                assert.equal(route.request().method(), 'POST');
                imports++;
                importPayload = route.request().postDataBuffer().toString();
                return route.fulfill({ json: { url: 'https://import.example/confirm?token=test%2Bvalue&cb=?' } });
            }
            if (url.pathname.endsWith('/list')) {
                if (route.request().method() === 'POST') {
                    posts++;
                    payload = route.request().postDataBuffer().toString();
                    return route.fulfill({ json: 'Файл сохранен, ожидается обработка' });
                }
                return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
            }
            if (url.pathname.endsWith('/state')) {
                polls++;
                return route.fulfill({ json: { message: status, inProcess: status.includes('Обработано') } });
            }
            if (url.pathname === '/old.xlsx') oldDownloads++;
            if (url.pathname === '/report.xlsx') {
                downloads++;
                return route.fulfill({ body: bytes, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            }
            return route.fulfill({ status: 404 });
        });
        // Даём Playwright подключить подмену запросов в изолированном документе JSONP.
        const routedSource = source.replace('document.head.append(script);',
            "if (script.hasAttribute('src')) setTimeout(() => document.head.append(script), 200); else document.head.append(script);");
        await page.addInitScript({ content: `
            window.GM_getValue = (key, fallback) => sessionStorage.getItem(key) ?? fallback;
            window.GM_setValue = (key, value) => sessionStorage.setItem(key, value);
            ${routedSource}` });
        await page.goto('https://admin.adeo.pro/admin/admin_pricerelevance/list?adeo-auto-price=1', { waitUntil: 'commit' });
        const file = page.locator('input[type=file]');
        const launch = page.getByRole('button', { name: 'Запустить', exact: true });
        const salesOption = page.getByRole('checkbox', { name: 'Анализ на продаваемость' });
        const importOption = page.getByRole('checkbox', { name: 'Импорт в тестовую ячейку' });
        const bar = page.locator('.adeo-relevance-bar');
        const busyNotice = page.getByText('Отчёт по продаваемости занят другим файлом.', { exact: false });
        const selectFile = name => file.setInputFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from('прайс') });
        const dropPrice = names => page.evaluate(names => {
            const target = document.querySelector('h1');
            const overlay = document.querySelector('.adeo-relevance-drop');
            const dataTransfer = new DataTransfer();
            for (const name of names) dataTransfer.items.add(new File(['прайс'], name));
            const event = type => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer });
            target.dispatchEvent(event('dragenter'));
            target.dispatchEvent(event('dragover'));
            const { width, height } = overlay.getBoundingClientRect();
            const message = overlay.textContent;
            const prevented = !target.dispatchEvent(event('drop'));
            return { fullScreen: width === innerWidth && height === innerHeight, message, prevented, hidden: overlay.hidden };
        }, names);
        const waitForLaunch = () => page.waitForFunction(() => !document.querySelector('.adeo-auto-price-launch').disabled);
        assert.equal(await page.locator('h1').innerText(), 'Авто проверка прайса');
        assert.deepEqual(await page.locator('.adeo-auto-price-switch > [name^=run-]').evaluateAll(inputs => inputs.map(input => input.name)),
            ['run-import', 'run-marketability', 'run-sales']);
        assert.deepEqual(await page.locator('.adeo-auto-price-report h2').allTextContents(),
            ['Импорт в тестовую ячейку', 'Отчёт о конкурентоспособности', 'Продаваемость']);
        const options = page.locator('.adeo-auto-price-option');
        await page.setViewportSize({ width: 1200, height: 844 });
        const desktop = await options.evaluateAll(cards => cards.map(card => card.getBoundingClientRect().top));
        assert.equal(new Set(desktop).size, 1, 'На широком экране настройки стоят в один ряд');
        await page.setViewportSize({ width: 390, height: 844 });
        const mobile = await options.evaluateAll(cards => cards.map(card => card.getBoundingClientRect().top));
        assert.ok(mobile[0] < mobile[1] && mobile[1] < mobile[2], 'На узком экране порядок карточек сохраняется');
        assert.equal(await file.count(), 1);
        assert.equal(await page.locator('form, #submitButton, #status').count(), 0);
        assert.equal(await page.evaluate(() => typeof window.refreshJobState), 'undefined');
        const cell = page.getByLabel('Тестовая ячейка');
        assert.equal(await cell.locator('option').count(), 10);
        assert.equal(await cell.inputValue(), '1');
        await cell.selectOption('7');
        await page.reload({ waitUntil: 'commit' });
        assert.equal(await cell.inputValue(), '7');
        await page.getByRole('checkbox', { name: 'Отчёт о конкурентоспособности' }).uncheck();
        const period = page.getByLabel('Период продаваемости');
        assert.equal(await period.inputValue(), '30');
        assert.equal(await salesOption.isChecked(), true);
        assert.equal(await importOption.isChecked(), true);
        assert.equal(await launch.isDisabled(), true, 'Для запуска нужен файл');
        await period.selectOption('custom');
        await busyNotice.waitFor();
        assert.deepEqual(await dropPrice(['Прайс.xlsx']), {
            fullScreen: true, message: 'Отпустите один файл XLS или XLSX для выбора', prevented: true, hidden: true
        });
        assert.equal(await file.evaluate(input => input.files[0]?.name), 'Прайс.xlsx');
        await dropPrice(['a.xls', 'b.xlsx']);
        assert.match(await page.locator('.adeo-file-error').innerText(), /один непустой файл/);
        assert.equal(await file.evaluate(input => input.files[0]?.name), 'Прайс.xlsx');
        assert.equal(await launch.isDisabled(), true, 'Очередь ADEO считается занятой даже при inProcess=false');
        assert.equal(posts, 0);
        status = oldResult;
        await busyNotice.waitFor({ state: 'hidden' });
        assert.equal(await launch.isDisabled(), true, 'Свой период требует даты начала');
        await page.getByLabel('Дата начала').fill('2099-01-01');
        assert.equal(await launch.isDisabled(), true, 'Дата начала не может быть в будущем');
        await page.getByLabel('Дата начала').fill('2020-01-15');
        await waitForLaunch();
        assert.equal(await busyNotice.isVisible(), false);
        await selectFile('Прайс.txt');
        assert.match(await page.locator('.adeo-file-error').innerText(), /XLS/);
        assert.equal(await launch.isDisabled(), true, 'Для запуска нужен файл Excel');
        assert.equal(posts, 0);
        status = 'Обработано 1 строк из 2';
        await selectFile('Прайс.xlsx');
        assert.equal(await launch.isEnabled(), true);
        assert.equal(posts, 0, 'Выбор файла не отправляет его на продаваемость');
        assert.equal(imports, 0, 'Выбор файла не запускает импорт');
        await launch.click();
        await busyNotice.waitFor();
        assert.equal(await launch.isDisabled(), true, 'Повторная проверка обнаруживает файл, занявший отчёт после открытия вкладки');
        assert.equal(posts, 0);
        status = oldResult;
        await waitForLaunch();
        assert.equal(posts, 0, 'После освобождения отчёта требуется нажать кнопку');
        assert.equal(imports, 0, 'Отклонённый на предварительной проверке файл не отправляется на импорт');
        const pollsBeforeUpload = polls;
        await launch.click();
        await page.waitForFunction(() => {
            const stage = document.querySelector('.adeo-relevance-bar').dataset.stage;
            return stage === 'queued' || stage === 'error' || !document.querySelector('.adeo-file-error').hidden;
        }, null, { polling: 100 }).catch(async error => {
            throw new Error(`${error.message}\n${await page.locator('body').innerText()}\nОтправок: ${posts}, статусов: ${polls}`);
        });
        assert.equal(await bar.getAttribute('data-stage'), 'queued', await page.locator('body').innerText());
        await page.getByText('Тестовая ячейка занята.', { exact: false }).waitFor();
        assert.equal(imports, 0);
        assert.equal(await file.isDisabled(), true);
        assert.equal(await launch.isDisabled(), true);
        assert.equal((await dropPrice(['Другой.xls'])).message, 'Дождитесь завершения текущей проверки');
        assert.equal(await file.evaluate(input => input.files[0]?.name), 'Прайс.xlsx');
        assert.match(payload, /name="price"; filename=/);
        for (const [name, value] of [['pn', '2'], ['brand', '1'], ['outStart', '5'], ['csrf', 'token']]) {
            assert.ok(payload.includes(`name="${name}"\r\n\r\n${value}\r\n`));
        }
        assert.match(payload, /name="start_date"\r\n\r\n2020-01-15/);
        assert.match(payload, /name="orders_count"/);
        assert.match(payload, /name="orders_min_cost"/);
        assert.doesNotMatch(payload, /name="(?:orders_avg_cost|orders_max_cost|description)"/);
        await page.waitForFunction(min => performance.getEntriesByType('resource').filter(entry => entry.name.endsWith('/state')).length >= min,
            pollsBeforeUpload + 2, { polling: 100 });
        assert.equal(await bar.getAttribute('data-stage'), 'queued', 'Предыдущий отчёт не завершает новый запуск');
        status = 'Обработано 1 строк из 2';
        await page.waitForFunction(() => document.querySelector('.adeo-relevance-bar').dataset.stage === 'processing', null, { polling: 100 });
        status = result;
        await page.waitForFunction(() => document.querySelector('.adeo-relevance-bar').dataset.analysisPhase === 'done', null, { polling: 100 });
        assert.equal(posts, 1);
        assert.ok(polls >= pollsBeforeUpload + 4);
        assert.equal(oldDownloads, 0);
        assert.equal(downloads, 1);
        assert.deepEqual(await page.locator('.adeo-analysis-grid strong').allTextContents(), ['20 ₽', '1', '2', '-20,00%', '20 ₽']);
        assert.match(await page.locator('.adeo-analysis-brands').innerText(), /Неизвестные бренды: 1/);
        assert.match(await page.locator('.adeo-analysis-warnings').innerText(), /Предупреждений: 1/);
        assert.equal(await page.getByRole('button', { name: 'Повторить анализ', exact: true }).count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(await file.isDisabled(), true, 'Выбор нового прайса заблокирован, пока тот же файл ждёт импорта');
        cellBusy = false;
        await page.getByText('Импорт окончен. Строк: 4', { exact: true }).waitFor().catch(async error => {
            const statusText = await page.locator('.adeo-auto-price-import-status').innerText();
            throw new Error(`${error.message}\nСтатус: ${statusText}\nИмпортов: ${imports}, подтверждений: ${confirmations}\n${errors.join('\n')}`);
        });
        await waitForLaunch();
        assert.equal(await page.locator('#adeo-auto-price-import-title').innerText(), 'Импорт в CellaTEST/7');
        const importResult = page.getByRole('region', { name: 'Результат импорта' });
        assert.deepEqual((await importResult.locator('strong').allTextContents()).map(value => value.replace(/\s/g, '')), ['7297', '6556']);
        assert.match(await importResult.innerText(), /Нулевые остатки: 0/);
        await importResult.getByText('Отсутствует или неверный артикул: 738', { exact: true }).click();
        assert.equal(await importResult.getByText('Строка 106 отсутствует артикул: образец').isVisible(), true);
        await importResult.getByText('Неизвестных брендов: 10', { exact: true }).click();
        assert.equal(await importResult.getByText('TEST BRAND', { exact: true }).isVisible(), true);
        assert.equal(await importResult.getByText('Пустое значение', { exact: true }).isVisible(), true);
        assert.equal(imports, 1);
        assert.equal(confirmations, 1);
        const filePart = /name="price"; filename="[^"]+"\r\nContent-Type: [^\r\n]+\r\n\r\n([^\r]+)\r\n/;
        assert.equal(importPayload.match(filePart)?.[1], payload.match(filePart)?.[1]);
        assert.equal(importPayload.match(filePart)?.[1], 'прайс');
        const downloadPromise = page.waitForEvent('download');
        const downloadLink = bar.getByRole('link', { name: 'Скачать исходный отчёт', exact: true });
        assert.equal(await downloadLink.evaluate(link => getComputedStyle(link).backgroundColor), 'rgb(40, 100, 154)');
        await downloadLink.click();
        const download = await downloadPromise;
        assert.deepEqual(readFileSync(await download.path()), bytes);

        status = 'Обработано 1 строк из 2';
        await salesOption.uncheck();
        const pollsBeforeImportOnly = polls;
        await launch.click();
        await waitForLaunch();
        assert.equal(imports, 2);
        assert.deepEqual(await importResult.locator('strong').allTextContents(), ['4', '4']);
        assert.doesNotMatch(await importResult.innerText(), /Нет данных|Ошибки и пропуски/);
        assert.equal(posts, 1, 'Режим импорта не отправляет файл на продаваемость');
        assert.equal(polls, pollsBeforeImportOnly, 'Режим импорта не ждёт отчёт продаваемости');

        await importOption.uncheck();
        assert.equal(await launch.isDisabled(), true, 'Для запуска нужен хотя бы один этап');
        status = oldResult;
        await salesOption.check();
        await waitForLaunch();
        await launch.click();
        await page.waitForFunction(() => document.querySelector('.adeo-relevance-bar').dataset.stage === 'queued');
        status = 'Обработано 1 строк из 2';
        await page.waitForFunction(() => document.querySelector('.adeo-relevance-bar').dataset.stage === 'processing');
        status = result;
        await waitForLaunch();
        assert.equal(posts, 2);
        assert.equal(imports, 2, 'Режим продаваемости не запускает импорт');
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

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
