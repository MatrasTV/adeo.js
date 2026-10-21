const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

let chromium;
try { ({ chromium } = require('playwright')); } catch { /* Проверка требует установленного Playwright. */ }

test('Первичная загрузка отправляет один запрос с остатком, ручное снятие флажка сохраняется', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome'
}, async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage();
        const requests = [];
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const endpoint = 'https://adeo.test/admin/supplier/price/compare/43068/3';
        const html = `<meta charset="utf-8"><form id="compare-settings" class="form-horizontal">
            <fieldset><div class="checkbox"><label><div class="icheckbox_minimal" aria-checked="false">
            <input type="checkbox" name="remains">Остаток</div></label></div></fieldset></form>
            <script>
                window.responses = 0;
                window.changes = 0;
                function loadRows() {
                    const params = new URLSearchParams({page:'1',rows:'50',sidx:'cnt',sord:'desc'});
                    params.set('settings[bra_id]', 'on');
                    if (document.querySelector('input').checked) params.set('settings[remains]', 'on');
                    const xhr = new XMLHttpRequest();
                    xhr.open('POST', location.pathname);
                    xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
                    xhr.onload = () => window.responses++;
                    xhr.send(params.toString());
                }
                document.querySelector('form').addEventListener('change', () => { window.changes++; loadRows(); });
                // Посторонний запрос и детализация не должны расходовать одноразовую настройку.
                for (const url of ['/unrelated', '/admin/supplier/price/compare/list/43068/3']) {
                    const xhr = new XMLHttpRequest();
                    xhr.open('POST', url);
                    xhr.onload = () => window.responses++;
                    xhr.send('probe=1');
                }
                loadRows();
            </script>`;
        await page.route('https://adeo.test/**', async route => {
            const request = route.request();
            if (request.isNavigationRequest()) {
                await route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
            } else {
                requests.push({ url: request.url(), body: request.postData() });
                await route.fulfill({ contentType: 'application/json', body: '{"page":1,"records":0,"total":0,"rows":[]}' });
            }
        });
        const source = readFileSync(resolve(__dirname, '../adeo.user.js'), 'utf8');
        await page.addInitScript({ content: `window.originalOpen = XMLHttpRequest.prototype.open;
            window.originalSend = XMLHttpRequest.prototype.send;\n${source}` });
        await page.goto(endpoint);
        await page.waitForFunction(() => window.responses === 3);
        let mainRequests = requests.filter(request => request.url === endpoint);
        assert.equal(mainRequests.length, 1, 'При старте должен отправляться только один запрос таблицы');
        const initial = new URLSearchParams(mainRequests[0].body);
        assert.equal(initial.get('settings[remains]'), 'on');
        assert.equal(initial.get('settings[bra_id]'), 'on');
        assert.equal(initial.get('rows'), '50');
        assert.equal(await page.locator('input[name="remains"]').isChecked(), true);
        assert.equal(await page.locator('.icheckbox_minimal').getAttribute('aria-checked'), 'true');
        assert.equal(await page.evaluate(() => window.changes), 0);
        assert.equal(await page.evaluate(() => XMLHttpRequest.prototype.open === window.originalOpen &&
            XMLHttpRequest.prototype.send === window.originalSend), true, 'Исходные методы запросов должны восстановиться');
        assert.ok(requests.filter(request => request.url !== endpoint).every(request => request.body === 'probe=1'));

        await page.locator('.adeo-settings-toggle').click();
        await page.locator('input[name="remains"]').uncheck();
        await page.waitForFunction(() => window.responses === 4);
        mainRequests = requests.filter(request => request.url === endpoint);
        assert.equal(mainRequests.length, 2);
        assert.equal(new URLSearchParams(mainRequests[1].body).has('settings[remains]'), false);
        await page.evaluate(() => document.body.appendChild(document.createElement('span')));
        assert.equal(await page.locator('input[name="remains"]').isChecked(), false);
        assert.equal(await page.evaluate(() => window.changes), 1);
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
    }
});
