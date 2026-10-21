const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

let chromium;
try { ({ chromium } = require('playwright')); } catch { /* Проверка требует Playwright и Chrome. */ }

test('Индикатор отражает этапы, время, ошибки и независимые запросы детализаций', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome'
}, async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage();
        page.setDefaultTimeout(10000);
        const pending = [];
        const endpoint = 'https://adeo.test/admin/supplier/price/compare/43068/3';
        const html = `<meta charset="utf-8"><style>
            body { font: 14px Arial; } .ui-jqgrid { position: relative; width: 700px; height: 200px; }
            .loading { display: none; position: absolute; }
        </style><div class="ui-jqgrid" id="gbox_supplier_price_unique">
            <div class="loading" id="load_supplier_price_unique">Загрузка...</div>
            <div class="ui-jqgrid-bdiv"><div><table id="supplier_price_unique"></table></div></div>
        </div><div class="subgrid-data">
            <div class="ui-jqgrid"><div class="loading" id="load_detail1">Загрузка...</div><table id="detail1" class="ui-jqgrid-btable"></table></div>
            <div class="ui-jqgrid"><div class="loading" id="load_detail2">Загрузка...</div><table id="detail2" class="ui-jqgrid-btable"></table></div>
        </div><script>
            window.completed = 0;
            window.stages = [];
            new MutationObserver(() => {
                window.stages.push(document.querySelector('#load_supplier_price_unique').dataset.adeoStage);
            }).observe(document.querySelector('#load_supplier_price_unique'), { attributes: true, subtree: true, childList: true });
            document.querySelector('#detail1').p = { postData: { row_id: { storage_id: 11 } } };
            document.querySelector('#detail2').p = { postData: { row_id: { storage_id: 22 } } };
            window.startRequest = (url = location.pathname, storageId) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', url);
                xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
                xhr.onload = () => {
                    document.querySelector('#load_supplier_price_unique').style.display = 'none';
                    window.completed++;
                };
                xhr.send(storageId ? 'row_id[storage_id]=' + storageId : 'rows=50&page=1');
                return xhr;
            };
            window.active = window.startRequest();
        </script>`;
        await page.route('https://adeo.test/**', route => {
            if (route.request().isNavigationRequest()) {
                return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
            }
            pending.push(route);
        });
        await page.addInitScript({ content: readFileSync(resolve(__dirname, '../adeo.user.js'), 'utf8') });
        await page.goto(endpoint);
        const loader = page.locator('#load_supplier_price_unique');
        const message = loader.locator('.adeo-loading-message');
        assert.equal(await message.textContent(), 'Ожидание ответа сервера…');
        await page.waitForFunction(() => parseFloat(document.querySelector('.adeo-loading-timer').textContent.replace(',', '.')) >= 0.2);
        if (process.env.ADEO_LOADING_SCREENSHOT) await page.screenshot({ path: process.env.ADEO_LOADING_SCREENSHOT });
        // Проверяем обработку браузерных событий получения с известным и неизвестным размером.
        await page.evaluate(() => window.active.dispatchEvent(new ProgressEvent('progress', { lengthComputable: true, loaded: 25, total: 100 })));
        assert.equal(await message.textContent(), 'Получение данных… 25%');
        await page.evaluate(() => window.active.dispatchEvent(new ProgressEvent('progress', { loaded: 30 })));
        assert.equal(await message.textContent(), 'Получение данных…');
        await pending[0].fulfill({ contentType: 'application/json', body: '{"rows":[]}' });
        await page.waitForFunction(() => window.completed === 1 && document.querySelector('#load_supplier_price_unique').style.display === 'none');
        assert.equal(await page.evaluate(() => window.stages.includes('rendering')), true);

        await page.evaluate(() => { window.active = window.startRequest(); });
        await page.waitForFunction(() => document.querySelector('#load_supplier_price_unique').dataset.adeoStage === 'waiting');
        await pending[1].fulfill({ status: 500, contentType: 'application/json', body: '{}' });
        await page.waitForFunction(() => document.querySelector('#load_supplier_price_unique').dataset.adeoStage === 'error');
        assert.equal(await message.textContent(), 'Не удалось загрузить данные (HTTP 500)');
        assert.equal(await loader.isVisible(), true);

        await page.evaluate(() => { window.active = window.startRequest(); });
        await page.waitForFunction(() => document.querySelector('#load_supplier_price_unique').dataset.adeoStage === 'waiting');
        await pending[2].abort('failed');
        await page.waitForFunction(() => document.querySelector('.adeo-loading-message').textContent.includes('Ошибка сети'));

        await page.evaluate(() => { window.oldRequest = window.startRequest(); window.active = window.startRequest(); window.oldRequest.abort(); });
        assert.equal(await message.textContent(), 'Ожидание ответа сервера…', 'Отмена старого запроса не должна менять индикатор нового');
        await page.waitForFunction(() => document.querySelector('#load_supplier_price_unique').dataset.adeoStage === 'waiting');
        // Ожидаем, пока оба запроса попадут в обработчик маршрута.
        await page.waitForFunction(() => window.active.readyState === 1);
        const latest = pending.findLast(route => route.request().url() === endpoint && !route.request().failure());
        await latest.fulfill({ contentType: 'application/json', body: '{"rows":[]}' });
        await page.waitForFunction(() => document.querySelector('#load_supplier_price_unique').style.display === 'none');

        await page.evaluate(() => { window.active = window.startRequest(); window.active.abort(); });
        assert.equal(await message.textContent(), 'Загрузка отменена.');

        await page.evaluate(() => {
            const url = location.pathname.replace('/compare/', '/compare/list/');
            window.detailRequests = [window.startRequest(url, 11), window.startRequest(url, 22)];
        });
        assert.equal(await page.locator('#load_detail1').getAttribute('data-adeo-stage'), 'waiting');
        assert.equal(await page.locator('#load_detail2').getAttribute('data-adeo-stage'), 'waiting');
        await page.evaluate(() => window.detailRequests[0].abort());
        assert.equal(await page.locator('#load_detail1 .adeo-loading-message').textContent(), 'Загрузка отменена.');
        assert.equal(await page.locator('#load_detail2 .adeo-loading-message').textContent(), 'Ожидание ответа сервера…');
        await page.evaluate(() => window.detailRequests[1].abort());
    } finally {
        await browser.close();
    }
});
