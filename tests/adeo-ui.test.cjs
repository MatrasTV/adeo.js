const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

let chromium;
try { ({ chromium } = require('playwright')); } catch { /* Браузерная проверка необязательна без Playwright. */ }

test('Панель, переключатель Reg, оформление цен, копирование и сворачивание детализаций', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome'
}, async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('dialog', dialog => dialog.dismiss());
        function supplier(id, code) {
            return `<tr id="${id}" class="jqgrow"><td class="ui-sgcollapsed sgexpanded">−</td>
                <td aria-describedby="supplier_price_unique_supplier_cella">${code}</td>
                <td aria-describedby="supplier_price_unique_n_file">2</td>
                <td aria-describedby="supplier_price_unique_supplier_fullname">ООО «Поставщик»</td>
                <td aria-describedby="supplier_price_unique_cnt">100</td>
                <td aria-describedby="supplier_price_unique_prc_dup">18</td></tr>`;
        }
        const differences = ['-18', '10', '0', '1,5', '—'];
        const detailRows = differences.map((difference, i) => `<tr class="jqgrow">
            <td aria-describedby="detail_pn_clean">Арт${i}</td><td aria-describedby="detail_cbg_group_code">Бренд</td>
            <td aria-describedby="detail_p_pn_draft">Артикул</td><td aria-describedby="detail_p_pn_price_desc">Описание</td>
            <td aria-describedby="detail_p_cost_eval">100</td><td aria-describedby="detail_p_remains">10</td>
            <td aria-describedby="detail_cp_pn_draft">Артикул</td><td aria-describedby="detail_cp_pn_price_desc">Описание</td>
            <td aria-describedby="detail_cp_cost_eval">82</td><td aria-describedby="detail_cp_cost_eval_diff">${difference}</td>
            <td aria-describedby="detail_cp_remains">5</td></tr>`).join('');
        const html = `<style>
            body { font: 14px Arial; margin: 20px; } table { border-collapse: collapse; width: 100%; }
            td, th { border: 1px solid #ddd; padding: 2px 5px; } td { white-space: pre; }
            fieldset { border: 0; } .ui-jqgrid-bdiv { overflow: auto; }
        </style><form class="form-horizontal"><fieldset><legend>Настройки отображения</legend>
            <div class="checkbox"><label><input name="remains" type="checkbox">Остаток</label></div>
        </fieldset></form><div class="ui-jqgrid"><div class="ui-jqgrid-bdiv"><div style="height:1150px">
            <div style="height:0;display:none"></div><table id="supplier_price_unique"><tbody>
            ${supplier('reg', 'Reg123')}<tr class="ui-subgrid" id="reg-details"><td colspan="6">Детализация Reg</td></tr>
            ${supplier('cella', 'Cella1037')}<tr class="ui-subgrid" id="cella-details"><td class="subgrid-data" colspan="6">
                <table class="ui-jqgrid-htable"><thead><tr>
                <th role="columnheader" colspan="3">Топ 500 позиций</th><th role="columnheader" colspan="4">CellaTEST/3</th>
                <th role="columnheader" colspan="5">Cella1037/2</th></tr></thead></table>
                <table class="ui-jqgrid-btable"><tbody>${detailRows}</tbody></table>
            </td></tr>${supplier('other', 'Cella055')}
            </tbody></table></div></div></div>`;
        await page.route('https://adeo.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
        await page.goto('https://adeo.test/admin/supplier/price/compare/43068/3');
        await page.evaluate(() => {
            window.copied = [];
            window.formChanges = 0;
            document.querySelector('form').addEventListener('change', () => window.formChanges++);
            Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => {
                if (window.rejectCopy) throw new Error('Доступ запрещён');
                window.copied.push(text);
            } } });
            // Имитируем публичный метод jqGrid, сохраняя его поведение при закрытии строк.
            window.jQuery = table => ({ jqGrid(method, id) {
                if (method !== 'collapseSubGridRow') throw new Error('Неожиданный метод');
                const row = document.getElementById(id);
                row.querySelector('.sgexpanded')?.classList.replace('sgexpanded', 'sgcollapsed');
                if (row.nextElementSibling?.classList.contains('ui-subgrid')) row.nextElementSibling.style.display = 'none';
            } });
            window.jQuery.fn = { jqGrid() {} };
        });
        await page.addScriptTag({ content: readFileSync(resolve(__dirname, '../adeo.user.js'), 'utf8') });
        await page.waitForFunction(() => document.querySelector('.adeo-row-count')?.textContent === 'Показано: 2 · Скрыто Reg: 1');
        assert.equal(await page.locator('fieldset').isVisible(), false);
        assert.equal(await page.locator('.adeo-settings-toggle').getAttribute('aria-expanded'), 'false');
        const heights = await page.locator('.adeo-toolbar > button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height));
        assert.deepEqual([...new Set(heights)], [36]);
        assert.equal(await page.locator('#cella').evaluate(row => row.classList.contains('adeo-expanded')), true);
        assert.equal(await page.locator('#other').evaluate(row => row.classList.contains('adeo-row-odd')), true);
        assert.match(await page.locator('.adeo-current-price').innerText(), /Текущий прайс[\s\S]*CellaTEST\/3/);
        assert.match(await page.locator('.adeo-compared-price').innerText(), /Прайс сравнения[\s\S]*Cella1037\/2/);
        assert.deepEqual(await page.locator('td[aria-describedby="detail_cp_cost_eval_diff"]').allTextContents(), ['−18%', '+10%', '0%', '+1,5%', '—']);
        assert.equal(await page.locator('.adeo-price-lower').count(), 1);
        assert.equal(await page.locator('.adeo-price-higher').count(), 2);
        if (process.env.ADEO_UI_SCREENSHOT) await page.screenshot({ path: process.env.ADEO_UI_SCREENSHOT, fullPage: true });

        const changesBefore = await page.evaluate(() => window.formChanges);
        await page.locator('.adeo-hide-reg').click();
        assert.equal(await page.locator('#reg').isVisible(), true);
        assert.equal(await page.locator('.adeo-row-count').textContent(), 'Показано: 3 · Скрыто Reg: 0');
        assert.equal(await page.evaluate(() => window.formChanges), changesBefore);
        await page.locator('.adeo-hide-reg').click();
        await page.locator('.adeo-settings-toggle').click();
        assert.equal(await page.locator('fieldset').isVisible(), true);
        assert.equal(await page.locator('.adeo-settings-toggle').getAttribute('aria-expanded'), 'true');
        await page.locator('.adeo-settings-toggle').click();
        assert.equal(await page.locator('fieldset').isVisible(), false);

        await page.locator('#cella .adeo-copy-button').click();
        await page.waitForFunction(() => document.querySelector('#cella .adeo-copy-button').textContent === 'Скопировано ✓');
        assert.equal(await page.evaluate(() => window.copied[0]), 'Cella1037/2 (100) 18%');
        await page.locator('.adeo-copy-header-button').click();
        assert.equal(await page.evaluate(() => window.copied[1].split('\n')[0].split('\t')[10]), '-18');
        assert.equal(await page.evaluate(() => window.copied[1].split('\n')[3].split('\t')[10]), '1,5');
        await page.waitForFunction(() => document.querySelector('.adeo-copy-header-button').textContent === 'Копировать пересечения');
        await page.evaluate(() => { window.rejectCopy = true; });
        await page.locator('.adeo-copy-header-button').click();
        assert.equal(await page.locator('.adeo-copy-header-button').textContent(), 'Копировать пересечения');

        await page.locator('.adeo-collapse-all').click();
        assert.equal(await page.locator('#cella-details').isVisible(), false);
        assert.equal(await page.locator('.adeo-collapse-all').isDisabled(), true);
        await page.locator('.adeo-hide-reg').click();
        assert.equal(await page.locator('#reg-details').isVisible(), false, 'Закрытая детализация Reg не должна открываться при снятии фильтра');
        assert.equal(await page.locator('.adeo-toolbar').count(), 1);
        assert.equal(await page.locator('#adeo-compare-styles').count(), 1);
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
    }
});
