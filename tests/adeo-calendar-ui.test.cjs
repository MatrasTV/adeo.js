const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { mkdirSync, readFileSync } = require('node:fs');

let chromium;
try { ({ chromium } = require('playwright')); } catch { /* Браузерные проверки доступны при установленном Playwright. */ }

async function captureLayout(page, name) {
    if (!process.env.ADEO_UI_SCREENSHOT_DIR) return;
    mkdirSync(process.env.ADEO_UI_SCREENSHOT_DIR, { recursive: true });
    await page.locator('.adeo-schedule-modal').screenshot({ path: resolve(process.env.ADEO_UI_SCREENSHOT_DIR, `${name}.png`) });
}

async function assertDialogFits(page) {
    const dimensions = await page.locator('.adeo-schedule-modal').evaluate(modal => {
        const bounds = modal.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom,
            width: innerWidth, height: innerHeight, headingSizes: [...modal.querySelectorAll('h3')].map(node => parseFloat(getComputedStyle(node).fontSize)) };
    });
    assert.ok(dimensions.left >= 0 && dimensions.right <= dimensions.width, 'Окно должно помещаться по ширине экрана');
    assert.ok(dimensions.top >= 0 && dimensions.bottom <= dimensions.height, 'Окно должно помещаться по высоте экрана');
    assert.ok(dimensions.headingSizes.every(size => size <= 24), 'Глобальный стиль CRM не должен увеличивать заголовки мастера');
    const footer = page.locator('.adeo-schedule-footer');
    if (await footer.isVisible()) {
        for (const control of await footer.locator('button').all()) assert.ok(await control.isVisible(), 'Основные действия должны быть видны');
    }
}

async function fixture(path = '/supplier/supplier-list') {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, timezoneId: 'Europe/Moscow' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    // Все обращения к домену подменены локальной страницей; настоящая CRM в тесте недоступна.
    await page.route('https://crm.adeo.pro/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
        '<html lang="ru"><head><meta charset="UTF-8"><style>body{font:14px Arial;margin:20px;background:#eef1f5}h3{font-size:48px;line-height:1.2;font-weight:400;margin:40px 0}button,input,select{font-family:serif}summary{display:block}td{padding:20px}</style></head><body><div id="q-app"><div class="q-dialog__inner"><main class="work-calendar"><div class="row">Отправка заказов CellaTEST</div></main></div></div></body></html>' }));
    await page.goto(`https://crm.adeo.pro${path}`);
    const dates = await page.evaluate(() => {
        const day = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        const next = weekday => { const date = new Date(); date.setDate(date.getDate() + 1); while ((date.getDay() + 6) % 7 !== weekday) date.setDate(date.getDate() + 1); return day(date); };
        const add = (date, count) => { const result = new Date(`${date}T12:00:00`); result.setDate(result.getDate() + count); return day(result); };
        window.events = []; window.mutations = []; window.refreshed = 0;
        const native = {
            async list() { return { data: JSON.parse(JSON.stringify(window.events)) }; },
            async create(payload) {
                window.mutations.push({ type: 'create', payload: { ...payload } });
                window.events.push({ ...payload, id: 1000 + window.mutations.length, weeklyScheduleId: 2000 + window.mutations.length });
                if (window.failNextCreate) { window.failNextCreate = false; throw new Error('Ответ сервера потерян'); }
                return { data: { id: 1000 + window.mutations.length } };
            },
            async remove(id, future) {
                window.mutations.push({ type: 'remove', id, future });
                const target = window.events.find(event => event.id === id);
                window.events = window.events.filter(event => future ? event.weeklyScheduleId !== target.weeklyScheduleId ||
                    event.ordersAcceptedAt < target.ordersAcceptedAt : event.id !== id);
                return { data: true };
            }
        };
        const main = document.querySelector('.work-calendar');
        window.calendarProxy = { supplier: { id: 127, cella: 'CellaTEST' }, storages: [{ nfile: 7, name: 'Основной' }],
            $API: { supplier: { schedule: native } }, $el: main, async loadSchedules() { window.refreshed++; } };
        document.querySelector('#q-app').__vue_app__ = { _container: { _vnode: { component: { subTree: { children: [
            { component: { type: { name: 'WorkCalendarQuasar' }, proxy: window.calendarProxy } }
        ] } } } } };
        return { friday: next(4), saturday: add(next(4), 1), source: next(1), target: add(next(1), 2), delivery: add(next(1), 3) };
    });
    await page.addScriptTag({ path: resolve(__dirname, '../adeo.user.js') });
    return { browser, page, dates, errors };
}

test('Мастер заполняет 20 записей, исправляет субботу и восстанавливается после потери ответа', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome', timeout: 90000
}, async () => {
    const { browser, page, dates, errors } = await fixture();
    try {
        await page.getByRole('button', { name: 'Мастер расписания', exact: true }).click();
        await page.getByRole('button', { name: 'Заполнить с нуля' }).click();
        await page.getByLabel('Номер склада', { exact: true }).selectOption('7');
        await page.getByLabel('Начать с', { exact: true }).fill(dates.friday);
        const orderDays = page.locator('.adeo-schedule-box').filter({ hasText: '2. Когда отправлять' });
        for (const name of ['Понедельник', 'Вторник', 'Среда', 'Четверг']) await orderDays.getByLabel(name, { exact: true }).uncheck();
        const deliveryDays = page.locator('.adeo-schedule-box').filter({ hasText: '3. Когда поставщик' });
        await deliveryDays.getByLabel('Суббота', { exact: true }).check();
        assert.equal(await deliveryDays.getByLabel('Воскресенье', { exact: true }).isDisabled(), true);
        await page.getByRole('button', { name: 'Далее: заполнить день', exact: true }).click();
        for (let index = 1; index < 20; index++) await page.getByRole('button', { name: '＋ Добавить запись', exact: true }).click();
        const rows = page.locator('.adeo-schedule-template .adeo-schedule-row');
        assert.equal(await rows.count(), 20);
        for (let index = 0; index < 20; index++) {
            await rows.nth(index).getByLabel('Отправка заказа', { exact: true }).fill(`${String(index).padStart(2, '0')}:00`);
            await rows.nth(index).getByLabel('Интервал доставки', { exact: true }).selectOption('17');
        }
        await page.getByRole('button', { name: 'Заполнить выбранные дни', exact: true }).click();
        assert.equal(await page.locator('.adeo-schedule-day').count(), 7);
        await page.getByText('Суббота: исправить время у 20 доставок', { exact: true }).waitFor();
        await page.getByLabel('Общий интервал для выбранных записей', { exact: true }).selectOption('15');
        await page.getByRole('button', { name: 'Применить к выбранным', exact: true }).click();
        assert.match(await page.locator('[data-schedule-summary]').textContent(), /Записей: 20.*Замечаний: 0/);
        assert.equal(await page.evaluate(() => window.mutations.length), 0);
        if (process.env.ADEO_CALENDAR_SCREENSHOT) await page.screenshot({ path: process.env.ADEO_CALENDAR_SCREENSHOT });
        await page.getByRole('button', { name: 'Сохранить всё', exact: true }).click();
        await page.getByRole('button', { name: 'Подтвердить сохранение', exact: true }).waitFor();
        assert.equal(await page.evaluate(() => window.mutations.length), 0);
        await page.evaluate(() => { window.failNextCreate = true; });
        await page.getByRole('button', { name: 'Подтвердить сохранение', exact: true }).click();
        await page.getByRole('heading', { name: 'Сохранение остановлено', exact: true }).waitFor();
        assert.equal(await page.evaluate(() => window.mutations.length), 1);
        await page.getByRole('button', { name: 'Проверить результат и продолжить', exact: true }).click();
        await page.getByRole('heading', { name: 'Расписание сохранено', exact: true }).waitFor();
        const saved = await page.evaluate(() => ({ mutations: window.mutations, events: window.events, refreshed: window.refreshed }));
        assert.equal(saved.mutations.length, 20);
        assert.equal(saved.refreshed, 1);
        assert.ok(saved.events.every(event => event.nfile === 7 && event.repeatWeekly && event.orderDeliveryIntervalStart.startsWith(`${dates.saturday}T15:00`) && event.orderDeliveryIntervalEnd.startsWith(`${dates.saturday}T16:00`)));
        assert.equal(new Set(saved.events.map(event => event.ordersAcceptedAt)).size, 20);
        assert.deepEqual(errors, []);
        await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
        assert.equal(await page.locator('.adeo-schedule-overlay').count(), 0);
    } finally { await browser.close(); }
});

async function seedCopy(page, dates) {
    await page.evaluate(({ source, target }) => {
        const entry = (id, date, time, nfile, weekly = true) => ({ id, supplierId: 127, nfile,
            weeklyScheduleId: weekly ? id + 100 : 0, ordersAcceptedAt: `${date}T${time}:00+03:00`,
            orderDeliveryIntervalStart: null, orderDeliveryIntervalEnd: null });
        window.events = [entry(1, source, '09:00', 7), entry(2, source, '12:00', null), entry(3, source, '13:00', 8, false),
            entry(4, target, '10:00', 7), entry(5, target, '14:00', null), entry(6, target, '11:00', 9)];
    }, dates);
    await page.getByRole('button', { name: 'Мастер расписания', exact: true }).click();
    await page.getByRole('button', { name: 'Скопировать день' }).click();
    await page.getByLabel('Из какого дня', { exact: true }).fill(dates.source);
    await page.getByLabel('В какой день', { exact: true }).fill(dates.target);
    await page.getByRole('button', { name: 'Подготовить копию', exact: true }).click();
    await page.getByRole('button', { name: 'Сохранить всё', exact: true }).waitFor();
}

test('Копирование берёт только еженедельные записи и при общем правиле заменяет пересекающиеся склады', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome', timeout: 45000
}, async () => {
    const { browser, page, dates, errors } = await fixture();
    try {
        await seedCopy(page, dates);
        assert.equal(await page.locator('.adeo-schedule-row').count(), 2);
        await page.getByRole('button', { name: 'Сохранить всё', exact: true }).click();
        await page.getByRole('button', { name: 'Везде заменить', exact: true }).click();
        assert.equal(await page.evaluate(() => window.mutations.length), 0);
        await page.getByRole('button', { name: 'Подтвердить сохранение', exact: true }).click();
        await page.getByRole('heading', { name: 'Расписание сохранено', exact: true }).waitFor();
        const data = await page.evaluate(() => ({ events: window.events, mutations: window.mutations }));
        assert.deepEqual(data.mutations.filter(item => item.type === 'remove').map(item => [item.id, item.future]), [[4, true], [5, true], [6, true]]);
        const created = data.mutations.filter(item => item.type === 'create').map(item => item.payload);
        assert.equal(created.length, 2);
        assert.deepEqual(created.map(item => item.nfile), [7, null]);
        assert.ok(created.every(item => item.ordersAcceptedAt.startsWith(dates.target) && item.repeatWeekly && item.orderDeliveryIntervalStart === null));
        assert.ok([1, 2, 3].every(id => data.events.some(event => event.id === id)));
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('Изменение расписания другим пользователем требует повторной проверки конфликтов', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome', timeout: 45000
}, async () => {
    const { browser, page, dates, errors } = await fixture();
    try {
        await seedCopy(page, dates);
        await page.getByRole('button', { name: 'Сохранить всё', exact: true }).click();
        await page.getByRole('button', { name: 'Везде заменить', exact: true }).click();
        await page.evaluate(() => { window.events[3].ordersAcceptedAt = window.events[3].ordersAcceptedAt.replace('10:00', '10:30'); });
        await page.getByRole('button', { name: 'Подтвердить сохранение', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: 'За время проверки расписание в CRM изменилось' }).waitFor();
        assert.equal(await page.evaluate(() => window.mutations.length), 0);
        assert.equal(await page.getByLabel('Действие', { exact: true }).inputValue(), '');
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('Кнопка появляется после перехода внутри CRM без перезагрузки страницы', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome', timeout: 45000
}, async () => {
    const { browser, page, errors } = await fixture('/dashboard');
    try {
        assert.equal(await page.getByRole('button', { name: 'Мастер расписания', exact: true }).count(), 0);
        await page.evaluate(() => { history.pushState(null, '', '/supplier/supplier-list'); document.querySelector('.work-calendar .row').append(document.createElement('span')); });
        await page.getByRole('button', { name: 'Мастер расписания', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Мастер расписания', exact: true }).click();
        await page.getByRole('button', { name: 'Заполнить с нуля' }).waitFor();
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('Копирование дня в черновике спрашивает действие, сдвигает доставку и сохраняет независимость дней', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome', timeout: 45000
}, async () => {
    const { browser, page, dates, errors } = await fixture();
    try {
        await page.getByRole('button', { name: 'Мастер расписания', exact: true }).click();
        await page.getByRole('button', { name: 'Заполнить с нуля' }).click();
        await page.getByLabel('Начать с', { exact: true }).fill(dates.friday);
        const orderDays = page.locator('.adeo-schedule-box').filter({ hasText: '2. Когда отправлять' });
        for (const name of ['Понедельник', 'Вторник', 'Среда', 'Четверг']) await orderDays.getByLabel(name, { exact: true }).uncheck();
        await page.getByRole('button', { name: 'Далее: заполнить день', exact: true }).click();
        await page.getByRole('button', { name: 'Заполнить выбранные дни', exact: true }).click();
        const friday = page.locator('.adeo-schedule-day').nth(4);
        const saturday = page.locator('.adeo-schedule-day').nth(5);
        await friday.getByRole('button', { name: 'На следующий день', exact: true }).click();
        assert.equal(await saturday.locator('.adeo-schedule-row').count(), 1);
        const deliveryDates = await page.locator('.adeo-schedule-row input[type="date"]').evaluateAll(inputs => inputs.map(input => input.value));
        const dateDifference = (new Date(`${deliveryDates[1]}T12:00:00Z`) - new Date(`${deliveryDates[0]}T12:00:00Z`)) / 86400000;
        assert.equal(dateDifference, 1);
        await friday.getByRole('button', { name: 'На следующий день', exact: true }).click();
        await page.getByRole('button', { name: 'Отмена', exact: true }).click();
        assert.equal(await saturday.locator('.adeo-schedule-row').count(), 1);
        await friday.getByRole('button', { name: 'На следующий день', exact: true }).click();
        await page.getByRole('button', { name: 'Заменить', exact: true }).click();
        assert.equal(await saturday.locator('.adeo-schedule-row').count(), 1);
        await friday.locator('.adeo-schedule-row > summary').click();
        await friday.getByLabel('Отправка заказа', { exact: true }).fill('10:00');
        await friday.locator('.adeo-schedule-row > summary').click();
        assert.match(await saturday.locator('.adeo-schedule-row > summary').textContent(), /^09:00/);
        assert.match(await friday.locator('.adeo-schedule-row > summary').textContent(), /^10:00/);
        await friday.getByRole('button', { name: 'На следующий день', exact: true }).click();
        await page.getByRole('button', { name: 'Добавить', exact: true }).click();
        assert.equal(await saturday.locator('.adeo-schedule-row').count(), 2);
        assert.equal(await page.evaluate(() => window.mutations.length), 0);
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('HTTP 417 отображает ответ CRM и останавливает очередь без повторной отправки', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome', timeout: 45000
}, async () => {
    const { browser, page, dates, errors } = await fixture();
    try {
        await seedCopy(page, dates);
        await page.evaluate(() => {
            window.rejectedRequests = 0;
            window.calendarProxy.$API.supplier.schedule.create = async () => {
                window.rejectedRequests++;
                const error = new Error('Request failed with status code 417');
                error.response = { status: 417, data: { message: 'Текст причины от CRM' } };
                throw error;
            };
        });
        await page.getByRole('button', { name: 'Сохранить всё', exact: true }).click();
        await page.getByRole('button', { name: 'Везде добавить', exact: true }).click();
        await page.getByRole('button', { name: 'Подтвердить сохранение', exact: true }).click();
        await page.getByRole('heading', { name: 'Сохранение остановлено', exact: true }).waitFor();
        const text = await page.getByRole('alert').textContent();
        assert.match(text, /HTTP 417/);
        assert.match(text, /Текст причины от CRM/);
        assert.match(text, /Отправка:/);
        assert.equal(await page.evaluate(() => window.rejectedRequests), 1);
        assert.equal(await page.evaluate(() => window.mutations.length), 0);
        await page.getByRole('button', { name: 'Проверить результат и продолжить', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: 'Продолжение заблокировано' }).waitFor();
        assert.equal(await page.evaluate(() => window.rejectedRequests), 1);
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('Заполнение с нуля для всех складов предлагает выбор при уже существующих отдельных расписаниях', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome', timeout: 45000
}, async () => {
    const { browser, page, dates, errors } = await fixture();
    try {
        await page.evaluate(date => {
            window.events = [7, 8].map((nfile, index) => ({ id: index + 1, weeklyScheduleId: index + 100,
                supplierId: 127, nfile, ordersAcceptedAt: `${date}T09:00:00+03:00`,
                orderDeliveryIntervalStart: null, orderDeliveryIntervalEnd: null }));
        }, dates.friday);
        await page.getByRole('button', { name: 'Мастер расписания', exact: true }).click();
        await page.getByRole('button', { name: 'Заполнить с нуля' }).click();
        assert.equal(await page.getByLabel('Номер склада', { exact: true }).inputValue(), '');
        await page.getByLabel('Начать с', { exact: true }).fill(dates.friday);
        const orderDays = page.locator('.adeo-schedule-box').filter({ hasText: '2. Когда отправлять' });
        for (const name of ['Понедельник', 'Вторник', 'Среда', 'Четверг']) await orderDays.getByLabel(name, { exact: true }).uncheck();
        await page.getByRole('button', { name: 'Далее: заполнить день', exact: true }).click();
        await page.getByRole('button', { name: 'Заполнить выбранные дни', exact: true }).click();
        await page.getByRole('button', { name: 'Сохранить всё', exact: true }).click();
        await page.getByLabel('Действие', { exact: true }).waitFor();
        assert.match(await page.locator('.adeo-schedule-conflict').textContent(), /Существующих правил: 2/);
        await page.getByRole('button', { name: 'Подтвердить сохранение', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: 'Выберите действие' }).waitFor();
        assert.equal(await page.evaluate(() => window.mutations.length), 0);
        await page.getByRole('button', { name: 'Везде добавить', exact: true }).click();
        await page.getByRole('button', { name: 'Подтвердить сохранение', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: 'уже существует' }).waitFor();
        assert.equal(await page.evaluate(() => window.mutations.length), 0);
        await page.getByRole('button', { name: 'Везде заменить', exact: true }).click();
        await page.getByRole('button', { name: 'Подтвердить сохранение', exact: true }).click();
        await page.getByRole('heading', { name: 'Расписание сохранено', exact: true }).waitFor();
        const operations = await page.evaluate(() => window.mutations);
        assert.deepEqual(operations.filter(item => item.type === 'remove').map(item => item.id), [1, 2]);
        assert.equal(operations.filter(item => item.type === 'create').length, 1);
        assert.equal(operations.at(-1).payload.nfile, null);
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

async function seedClear(page, dates) {
    await page.evaluate(({ source, target }) => {
        const today = new Date();
        const day = value => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
        const before = new Date(today); before.setDate(before.getDate() - 7);
        const later = new Date(`${source}T12:00:00`); later.setDate(later.getDate() + 7);
        const entry = (id, date, nfile, weeklyScheduleId) => ({ id, supplierId: 127, nfile, weeklyScheduleId,
            ordersAcceptedAt: `${date}T09:00:00+03:00`, orderDeliveryIntervalStart: null, orderDeliveryIntervalEnd: null });
        window.events = [entry(1, day(before), 7, 100), entry(2, day(today), 7, 100), entry(3, source, 7, 100),
            entry(4, day(later), 7, 100), entry(5, target, null, 0), entry(6, source, 8, 200), entry(7, day(before), null, 0)];
    }, dates);
}

test('Очистка требует подтверждения, удаляет будущее расписание всех складов и сохраняет историю', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome', timeout: 45000
}, async () => {
    const { browser, page, dates, errors } = await fixture();
    try {
        await seedClear(page, dates);
        await page.getByRole('button', { name: 'Очистить всё расписание', exact: true }).click();
        await page.getByRole('heading', { name: 'Очистка всего будущего расписания', exact: true }).waitFor();
        await assertDialogFits(page); await captureLayout(page, '11-clear');
        assert.match(await page.locator('.adeo-schedule-summary').textContent(), /Еженедельных правил: 2.*Разовых записей: 1.*отправок.*4/);
        assert.equal(await page.evaluate(() => window.mutations.length), 0);
        await page.getByRole('button', { name: 'Отмена', exact: true }).click();
        assert.equal(await page.locator('.adeo-schedule-overlay').count(), 0);
        assert.equal(await page.evaluate(() => window.mutations.length), 0);
        await page.getByRole('button', { name: 'Очистить всё расписание', exact: true }).click();
        await page.getByRole('button', { name: 'Подтвердить очистку всех складов', exact: true }).click();
        await page.getByRole('heading', { name: 'Будущее расписание очищено', exact: true }).waitFor();
        const data = await page.evaluate(() => ({ events: window.events, mutations: window.mutations, refreshed: window.refreshed }));
        assert.deepEqual(data.mutations.map(item => [item.type, item.id, item.future]), [['remove', 3, true], ['remove', 6, true], ['remove', 5, false]]);
        assert.deepEqual(data.events.map(item => item.id), [1, 2, 7]);
        assert.equal(data.refreshed, 1);
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('При изменении расписания очистка требует нового подтверждения', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome', timeout: 45000
}, async () => {
    const { browser, page, dates, errors } = await fixture();
    try {
        await seedClear(page, dates);
        await page.getByRole('button', { name: 'Очистить всё расписание', exact: true }).click();
        await page.getByRole('button', { name: 'Подтвердить очистку всех складов', exact: true }).waitFor();
        await page.evaluate(() => { window.events.push({ ...window.events[4], id: 8 }); });
        await page.getByRole('button', { name: 'Подтвердить очистку всех складов', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: 'Расписание изменилось' }).waitFor();
        assert.equal(await page.evaluate(() => window.mutations.length), 0);
        assert.match(await page.locator('.adeo-schedule-summary').textContent(), /Разовых записей: 2/);
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('Очистка из мастера не отправляет запросы при отсутствии будущих записей', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome', timeout: 45000
}, async () => {
    const { browser, page, errors } = await fixture();
    try {
        await page.getByRole('button', { name: 'Мастер расписания', exact: true }).click();
        const modal = page.getByRole('dialog');
        await modal.getByRole('button', { name: 'Очистить всё расписание', exact: true }).click();
        await page.getByRole('heading', { name: 'Очистка всего будущего расписания', exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Подтвердить очистку всех складов', exact: true }).count(), 0);
        assert.equal(await page.evaluate(() => window.mutations.length), 0);
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('Очистка не сообщает об успехе, если CRM продолжает возвращать будущие записи', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome', timeout: 45000
}, async () => {
    const { browser, page, dates, errors } = await fixture();
    try {
        await seedClear(page, dates);
        await page.evaluate(() => { window.calendarProxy.$API.supplier.schedule.remove = async () => ({ data: true }); });
        await page.getByRole('button', { name: 'Очистить всё расписание', exact: true }).click();
        await page.getByRole('button', { name: 'Подтвердить очистку всех складов', exact: true }).click();
        await page.getByRole('heading', { name: 'Очистка остановлена', exact: true }).waitFor();
        assert.match(await page.getByRole('alert').textContent(), /Очистка не подтверждена полностью/);
        assert.equal(await page.getByRole('heading', { name: 'Будущее расписание очищено', exact: true }).count(), 0);
        assert.equal(await page.evaluate(() => window.refreshed), 0);
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('Вёрстка мастера изолирована от CRM, шаблон компактен, а ошибки ведут к нужной записи', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome', timeout: 60000
}, async () => {
    const { browser, page, errors } = await fixture();
    try {
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.getByRole('button', { name: 'Мастер расписания', exact: true }).click();
        await page.getByRole('button', { name: 'Заполнить с нуля' }).waitFor();
        assert.ok((await page.locator('.adeo-schedule-modal').boundingBox()).width < 1100);
        await assertDialogFits(page); await captureLayout(page, '01-actions');
        await page.getByRole('button', { name: 'Заполнить с нуля' }).click();
        await assertDialogFits(page); await captureLayout(page, '02-settings');
        await page.getByRole('button', { name: 'Далее: заполнить день', exact: true }).click();
        for (let index = 1; index < 5; index++) await page.getByRole('button', { name: '＋ Добавить запись', exact: true }).click();
        const rows = page.locator('.adeo-schedule-template .adeo-schedule-row');
        for (let index = 0; index < 5; index++) await rows.nth(index).getByLabel('Отправка заказа', { exact: true }).fill(`${String(index + 7).padStart(2, '0')}:00`);
        const first = await rows.first().boundingBox(), second = await rows.nth(1).boundingBox();
        assert.ok(first.height < 130 && second.y >= first.y + first.height, 'Шаблон должен состоять из компактных неперекрывающихся строк');
        await assertDialogFits(page); await captureLayout(page, '03-template');
        await page.getByRole('button', { name: 'Заполнить выбранные дни', exact: true }).click();
        await assertDialogFits(page); await captureLayout(page, '04-week');
        await page.getByRole('button', { name: 'Назад', exact: true }).click();
        await page.locator('.adeo-schedule-template .adeo-schedule-row').first().getByRole('button', { name: 'Копия', exact: true }).click();
        await page.getByRole('button', { name: 'Заполнить выбранные дни', exact: true }).click();
        assert.equal(await page.locator('.adeo-schedule-row-invalid').count(), 10);
        await page.getByRole('button', { name: 'Сохранить всё', exact: true }).click();
        assert.match(await page.getByRole('alert').textContent(), /исправьте замечания: 5/);
        await captureLayout(page, '05-week-errors');
        await page.getByRole('button', { name: 'К первой ошибке', exact: true }).click();
        assert.equal(await page.locator('.adeo-schedule-row-invalid[open]').count(), 1);
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Отправка заказа');
        await page.setViewportSize({ width: 1366, height: 768 }); await assertDialogFits(page);
        assert.equal(await page.locator('.adeo-schedule-grid').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'На ноутбуке должны помещаться все семь дней без обрезания воскресенья');
        await captureLayout(page, '06-week-laptop');
        await page.getByRole('button', { name: 'Закрыть мастер', exact: true }).click();
        await page.getByRole('button', { name: 'Мастер расписания', exact: true }).click();
        await page.getByRole('button', { name: 'Заполнить с нуля' }).click();
        await page.setViewportSize({ width: 390, height: 844 }); await assertDialogFits(page); await captureLayout(page, '12-settings-mobile');
        await page.getByRole('button', { name: 'Далее: заполнить день', exact: true }).click();
        await assertDialogFits(page); await captureLayout(page, '13-template-mobile');
        const inputBounds = await page.getByLabel('Отправка заказа', { exact: true }).boundingBox();
        const modalBounds = await page.locator('.adeo-schedule-modal').boundingBox();
        assert.ok(inputBounds.x >= modalBounds.x && inputBounds.x + inputBounds.width <= modalBounds.x + modalBounds.width, 'Поле времени не должно выходить за край мобильного окна');
        assert.equal(await page.evaluate(() => window.mutations.length), 0);
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('Копия использует ширину окна, а свёрнутая история не блокирует замену', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome', timeout: 60000
}, async () => {
    const { browser, page, dates, errors } = await fixture();
    try {
        await page.setViewportSize({ width: 1920, height: 1080 });
        await seedCopy(page, dates);
        const widths = await page.evaluate(() => ({ modal: document.querySelector('.adeo-schedule-modal').getBoundingClientRect().width,
            content: document.querySelector('.adeo-schedule-content').clientWidth, grid: document.querySelector('.adeo-schedule-grid').getBoundingClientRect().width }));
        assert.ok(widths.modal < 1100 && widths.grid > widths.content * 0.85, 'Одна копируемая дата не должна оставлять пустую половину широкого окна');
        await assertDialogFits(page); await captureLayout(page, '07-copy');
        await page.evaluate(date => {
            const old = new Date(`${date}T12:00:00+03:00`); old.setDate(old.getDate() - 1001);
            const day = `${old.getFullYear()}-${String(old.getMonth() + 1).padStart(2, '0')}-${String(old.getDate()).padStart(2, '0')}`;
            for (let index = 0; index < 3; index++) window.events.push({ id: 90 + index, weeklyScheduleId: 900 + index, supplierId: 127, nfile: 7,
                ordersAcceptedAt: `${day}T0${index + 6}:00:00+03:00`, orderDeliveryIntervalStart: null, orderDeliveryIntervalEnd: null });
        }, dates.target);
        await page.getByRole('button', { name: 'Сохранить всё', exact: true }).click();
        await page.getByRole('button', { name: 'Подтвердить сохранение', exact: true }).waitFor();
        assert.equal(await page.locator('.adeo-schedule-history').evaluate(node => node.open), false);
        assert.match(await page.locator('.adeo-schedule-table th').first().evaluate(node => getComputedStyle(node).fontFamily), /Arial/i);
        assert.equal(await page.getByLabel('Действие', { exact: true }).locator('option[value="replace"]').evaluate(node => node.disabled), false);
        assert.equal(await page.getByRole('button', { name: 'Везде заменить', exact: true }).isEnabled(), true);
        await assertDialogFits(page); await captureLayout(page, '08-conflicts');
        await page.setViewportSize({ width: 1366, height: 768 }); await assertDialogFits(page); await captureLayout(page, '09-conflicts-laptop');
        await page.setViewportSize({ width: 390, height: 844 }); await assertDialogFits(page); await captureLayout(page, '10-conflicts-mobile');
        assert.equal(await page.evaluate(() => window.mutations.length), 0);
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('Ответ CRM с десятью историческими правилами позволяет заменить только будущие записи', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome', timeout: 45000
}, async () => {
    const { browser, page, errors } = await fixture();
    try {
        const records = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/crm-schedule-history.json'), 'utf8'));
        const seeded = await page.evaluate(records => {
            const day = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
            const monday = new Date(); monday.setDate(monday.getDate() + 1);
            while (monday.getDay() !== 1) monday.setDate(monday.getDate() + 1);
            const target = day(monday);
            const offset = Math.round((Date.parse(`${target}T12:00:00Z`) - Date.parse('2026-11-02T12:00:00Z')) / 86400000);
            const shift = value => {
                if (!value) return value;
                const date = new Date(`${value.slice(0, 10)}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + offset);
                return date.toISOString().slice(0, 10) + value.slice(10);
            };
            window.events = records.map(event => ({ ...event, ordersAcceptedAt: shift(event.ordersAcceptedAt),
                orderDeliveryIntervalStart: shift(event.orderDeliveryIntervalStart), orderDeliveryIntervalEnd: shift(event.orderDeliveryIntervalEnd) }));
            window.calendarProxy.supplier.id = 11;
            return { target, pastIds: window.events.filter(event => event.ordersAcceptedAt.slice(0, 10) < target).map(event => event.id) };
        }, records);
        await page.getByRole('button', { name: 'Мастер расписания', exact: true }).click();
        await page.getByRole('button', { name: 'Заполнить с нуля' }).click();
        await page.getByLabel('Начать с', { exact: true }).fill(seeded.target);
        const orderDays = page.locator('.adeo-schedule-box').filter({ hasText: '2. Когда отправлять' });
        for (const name of ['Вторник', 'Среда', 'Четверг', 'Пятница']) await orderDays.getByLabel(name, { exact: true }).uncheck();
        await page.getByRole('button', { name: 'Далее: заполнить день', exact: true }).click();
        await page.getByRole('button', { name: 'Заполнить выбранные дни', exact: true }).click();
        await page.getByRole('button', { name: 'Сохранить всё', exact: true }).click();
        await page.getByRole('button', { name: 'Подтвердить сохранение', exact: true }).waitFor();
        assert.match(await page.locator('.adeo-schedule-conflict').textContent(), /Существующих правил: 6/);
        assert.match(await page.locator('.adeo-schedule-history summary').textContent(), /10 правил/);
        assert.equal(await page.getByLabel('Действие', { exact: true }).locator('option[value="replace"]').evaluate(node => node.disabled), false);
        await page.getByRole('button', { name: 'Везде заменить', exact: true }).click();
        assert.equal(await page.evaluate(() => window.mutations.length), 0);
        await page.getByRole('button', { name: 'Подтвердить сохранение', exact: true }).click();
        await page.getByRole('heading', { name: 'Расписание сохранено', exact: true }).waitFor();
        const result = await page.evaluate(() => ({ operations: window.mutations, remainingIds: window.events.map(event => event.id) }));
        const removals = result.operations.filter(operation => operation.type === 'remove');
        assert.equal(removals.length, 6);
        assert.equal(result.operations.filter(operation => operation.type === 'create').length, 1);
        assert.ok(removals.every(operation => operation.future && !seeded.pastIds.includes(operation.id)));
        assert.ok(seeded.pastIds.every(id => result.remainingIds.includes(id)));
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('Замена остаётся недоступной за пределами загруженных дат действующего повтора', {
    skip: !chromium && 'Для проверки нужен Playwright и установленный Chrome', timeout: 45000
}, async () => {
    const { browser, page, dates, errors } = await fixture();
    try {
        await seedCopy(page, dates);
        await page.getByRole('button', { name: 'Назад', exact: true }).click();
        const later = new Date(`${dates.target}T12:00:00Z`); later.setUTCDate(later.getUTCDate() + 70);
        await page.getByLabel('В какой день', { exact: true }).fill(later.toISOString().slice(0, 10));
        await page.getByRole('button', { name: 'Подготовить копию', exact: true }).click();
        await page.getByRole('button', { name: 'Сохранить всё', exact: true }).click();
        await page.getByRole('button', { name: 'Подтвердить сохранение', exact: true }).waitFor();
        assert.equal(await page.getByLabel('Действие', { exact: true }).locator('option[value="replace"]').evaluate(node => node.disabled), true);
        assert.match(await page.locator('.adeo-schedule-warning').textContent(), /действующих правил/);
        assert.equal(await page.evaluate(() => window.mutations.length), 0);
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});
