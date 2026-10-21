const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

let chromium;
try {
    ({ chromium } = require('playwright'));
} catch {
    // Основные проверки не требуют браузера; эта проверка запускается при наличии Playwright.
}

test('Кнопки не увеличивают высоту строк jqGrid с переносами в названиях', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome'
}, async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        const source = readFileSync(resolve(__dirname, '../adeo.user.js'), 'utf8').replace(
            '    init();', '    globalThis.testApi = { addCopyButtons };'
        );
        // Существенные для ошибки правила взяты из сохранённой страницы jqGrid.
        await page.setContent(`<style>
            body { font: 12px Arial; }
            table { border-collapse: collapse; width: 1800px; table-layout: fixed; }
            td { overflow: hidden; white-space: pre; height: 23px; padding: 1px 2px;
                 border-bottom: 1px solid #ccc; box-sizing: border-box; }
            button { font: inherit; }
        </style><table><tbody id="rows"></tbody></table>`);
        await page.evaluate(() => {
            const names = ['Обычное название', 'Название с переносом\n', 'Название\r\n', '', 'Длинное название поставщика '.repeat(12)];
            const columns = ['supplier_cella', 'n_file', 'supplier_fullname', 'cnt', 'prc_dup'];
            names.forEach(name => {
                const row = document.querySelector('#rows').insertRow();
                row.className = 'jqgrow';
                columns.forEach((column, i) => {
                    const cell = row.insertCell();
                    cell.setAttribute('aria-describedby', `supplier_price_unique_${column}`);
                    cell.textContent = [ 'Cella', '1', name, '100', '20' ][i];
                });
            });
        });
        await page.addScriptTag({ content: source });
        const result = await page.evaluate(() => {
            testApi.addCopyButtons();
            testApi.addCopyButtons();
            return Array.from(document.querySelectorAll('tr.jqgrow'), row => {
                const height = row.getBoundingClientRect().height;
                const cell = row.querySelector('[aria-describedby="supplier_price_unique_supplier_fullname"]');
                const buttonCount = cell.querySelectorAll('button').length;
                // Сравниваем с выравниванием исходного скрипта на тех же строках.
                Object.assign(cell.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center' });
                return { height, originalHeight: row.getBoundingClientRect().height, buttonCount };
            });
        });
        result.forEach(row => {
            assert.equal(row.height, row.originalHeight, 'Высота должна совпадать с исходным выравниванием');
            assert.equal(row.buttonCount, 1, 'Повторное обновление не должно дублировать кнопку');
        });
    } finally {
        await browser.close();
    }
});

test('Скрытые строки не оставляют пустую прокрутку, резерв незагруженных записей сохраняется', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome'
}, async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(`<style>
            table { border-collapse: collapse; } td { height: 23px; padding: 0; }
        </style><div class="ui-jqgrid-bdiv" style="height:750px; overflow:auto">
            <div id="wrapper" style="position:relative; height:1150px">
                <div style="height:0; display:none"></div>
                <table id="supplier_price_unique"><tbody></tbody></table>
            </div></div>`);
        await page.evaluate(() => {
            const table = document.querySelector('table');
            table.p = { records: 50 };
            table.grid = { prevRowHeight: 23 };
            for (let i = 0; i < 50; i++) {
                const row = table.tBodies[0].insertRow();
                row.className = 'jqgrow';
                ['supplier_cella', 'n_file'].forEach((column, index) => {
                    const cell = row.insertCell();
                    cell.setAttribute('aria-describedby', `supplier_price_unique_${column}`);
                    cell.textContent = index ? '1' : `${i < 30 ? 'Reg' : 'Cella'}${i}`;
                });
            }
        });
        await page.addScriptTag({ content: readFileSync(resolve(__dirname, '../adeo.user.js'), 'utf8').replace(
            '    init();', '    globalThis.testApi = { filterSupplierRows, syncSupplierScrollHeight };'
        ) });
        const metrics = await page.evaluate(() => {
            testApi.filterSupplierRows();
            const area = document.querySelector('.ui-jqgrid-bdiv');
            const before = area.scrollHeight;
            testApi.syncSupplierScrollHeight();
            return { before, after: area.scrollHeight, viewport: area.clientHeight };
        });
        assert.ok(metrics.before > metrics.viewport, 'Исходная фиксированная высота воспроизводит ошибку');
        assert.equal(metrics.after, metrics.viewport, 'После исправления нет пустой области прокрутки');
        const reservedHeight = await page.evaluate(() => {
            document.querySelector('table').p.records = 100;
            testApi.syncSupplierScrollHeight();
            return document.querySelector('#wrapper').style.height;
        });
        assert.equal(reservedHeight, `${(100 - 30) * 23}px`);
        const allHidden = await page.evaluate(() => {
            const table = document.querySelector('table');
            delete table.grid.prevRowHeight;
            table.querySelectorAll('tr.jqgrow').forEach(row => { row.firstElementChild.textContent = 'Reg'; });
            testApi.filterSupplierRows();
            testApi.syncSupplierScrollHeight();
            const first = document.querySelector('#wrapper').style.height;
            testApi.syncSupplierScrollHeight();
            return [first, document.querySelector('#wrapper').style.height];
        });
        assert.deepEqual(allHidden, ['1150px', '1150px'], 'Повторный пересчёт не должен уменьшать резерв повторно');
    } finally {
        await browser.close();
    }
});

test('Фильтр Reg скрывает поставщика и детализацию, обрабатывает новые строки и изменение кода', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome'
}, async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage();
        const html = `<table><tbody>
            <tr class="jqgrow" id="reg"><td aria-describedby="supplier_price_unique_supplier_cella">Reg1993</td><td aria-describedby="supplier_price_unique_n_file">1</td></tr>
            <tr class="ui-subgrid" id="details"><td>Детализация</td></tr>
            <tr class="jqgrow" id="cella"><td aria-describedby="supplier_price_unique_supplier_cella">Cella1037</td><td aria-describedby="supplier_price_unique_n_file">1</td></tr>
            <tr class="jqgrow" id="lower"><td aria-describedby="supplier_price_unique_supplier_cella">reg1993</td><td aria-describedby="supplier_price_unique_n_file">1</td></tr>
            <tr class="jqgrow" id="inside"><td aria-describedby="supplier_price_unique_supplier_cella">Поставщик Reg123</td><td aria-describedby="supplier_price_unique_n_file">1</td></tr>
        </tbody></table>`;
        // Локальная имитация страницы: запросы к рабочей панели не выполняются.
        await page.route('https://adeo.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
        await page.goto('https://adeo.test/admin/supplier/price/compare/43068/3');
        await page.addScriptTag({ content: readFileSync(resolve(__dirname, '../adeo.user.js'), 'utf8') });
        assert.equal(await page.locator('#reg').isVisible(), false);
        assert.equal(await page.locator('#details').isVisible(), false);
        assert.equal(await page.locator('#inside').isVisible(), false);
        assert.equal(await page.locator('#cella').isVisible(), true);
        assert.equal(await page.locator('#lower').isVisible(), true);
        await page.evaluate(() => {
            const row = document.querySelector('#reg');
            row.firstElementChild.textContent = 'Cella1993';
            const added = document.querySelector('#cella').cloneNode(true);
            added.id = 'added';
            added.firstElementChild.textContent = 'Reg555';
            row.parentElement.appendChild(added);
        });
        await page.waitForFunction(() => document.querySelector('#added').style.display === 'none');
        assert.equal(await page.locator('#reg').isVisible(), true);
        assert.equal(await page.locator('#details').isVisible(), true);
        assert.equal(await page.locator('tr.jqgrow').count(), 5, 'Скрытые записи не удаляются из таблицы');
    } finally {
        await browser.close();
    }
});
