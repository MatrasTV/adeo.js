const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

// Проверяем расчёты без подключения к настоящей CRM.
const names = ['scheduleDay', 'parseScheduleDay', 'addScheduleDays', 'scheduleWeekday', 'nextScheduleWeekday',
    'nextScheduleDelivery', 'scheduleTimestamp', 'scheduleHourLabel', 'scheduleEventToDraft', 'scheduleDraftPayload',
    'validateScheduleDraft', 'buildScheduleWeek', 'copyScheduleDrafts', 'findScheduleConflicts', 'makeSchedulePlan',
    'createScheduleAdapter', 'runSchedulePlan', 'reconcileSchedulePlan', 'findScheduleProxy', 'scheduleFingerprint', 'describeScheduleRequestError', 'makeScheduleClearPlan'];
const source = readFileSync(resolve(__dirname, '../adeo.user.js'), 'utf8').replace(
    '    installLoadingProgress();', `    globalThis.calendar = { ${names.join(',')} }; return;`
);
function setup(document = {}) {
    const context = { Date, console, document };
    vm.runInNewContext(source, context);
    return context.calendar;
}
const api = setup();
const plain = value => JSON.parse(JSON.stringify(value));
const weekdays = [0, 1, 2, 3, 4, 5];
const tomorrow = () => api.addScheduleDays(api.scheduleDay(), 1);
function row(date = '2026-10-27', changes = {}) {
    return { uid: '1', nfile: 7, sendDate: date, sendTime: '09:00', haveDelivery: true,
        deliveryDate: api.addScheduleDays(date, 1), deliveryHour: 15, ...changes };
}
function event(id, date, changes = {}) {
    return { ...api.scheduleDraftPayload(row(date), 127), id, weeklyScheduleId: id + 100, ...changes };
}
function group(date, entries, nfiles = [7]) {
    return { date, enabled: true, nfiles, entries };
}

test('Срок в календарных днях переносит воскресенье на понедельник', () => {
    assert.equal(api.nextScheduleDelivery(api.addScheduleDays('2026-10-23', 2), weekdays), '2026-10-26');
    assert.equal(api.nextScheduleDelivery('2026-10-24', [0, 1, 2, 3, 4]), '2026-10-26');
    assert.throws(() => api.nextScheduleDelivery('2026-10-24', [6]), /Выберите/);
});

test('Календарные вычисления учитывают високосный год и переход года', () => {
    assert.equal(api.addScheduleDays('2028-02-28', 1), '2028-02-29');
    assert.equal(api.addScheduleDays('2026-12-31', 1), '2027-01-01');
    assert.equal(api.nextScheduleWeekday('2026-10-27', 0), '2026-11-02');
    assert.throws(() => api.parseScheduleDay('2026-02-30'), /Некорректная/);
    assert.throws(() => api.parseScheduleDay('2026-1-2'), /полностью/);
});

test('Мастер показывает понедельник–воскресенье и поддерживает 20 записей в день', () => {
    const template = Array.from({ length: 20 }, (_, hour) => ({ sendTime: `${String(hour).padStart(2, '0')}:00`,
        leadDays: 0, deliveryHour: 23, haveDelivery: true }));
    const week = api.buildScheduleWeek(template, [0, 1, 2, 3, 4, 5, 6], [0, 1, 2, 3, 4], '2026-10-27', null);
    assert.deepEqual(Array.from(week, item => item.weekday), [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(week.flatMap(item => item.entries).length, 140);
    assert.equal(week[5].entries[0].deliveryDate, '2026-11-02');
    assert.ok(week.every(day => day.date >= '2026-10-27'));
    assert.equal(new Set(week.flatMap(day => day.entries.map(item => item.uid))).size, 140);
    assert.throws(() => api.buildScheduleWeek([{ ...template[0], leadDays: 1.5 }], [0], weekdays, '2026-10-27', null), /целое/);
});

test('Короткая суббота: 15–16 разрешено, 16–17 требует исправления', () => {
    const draft = row('2026-10-23', { deliveryDate: '2026-10-24', deliveryHour: 15 });
    assert.equal(api.validateScheduleDraft(draft, weekdays, '2026-10-20').length, 0);
    assert.match(api.validateScheduleDraft({ ...draft, deliveryHour: 16 }, weekdays, '2026-10-20').join(), /В субботу/);
    assert.match(api.validateScheduleDraft({ ...draft, deliveryDate: '2026-10-25' }, weekdays, '2026-10-20').join(), /воскресенье/);
});

test('Нулевой срок разрешён, доставка раньше отправки запрещена', () => {
    assert.equal(api.validateScheduleDraft(row('2026-10-27', { deliveryDate: '2026-10-27' }), weekdays, '2026-10-26').length, 0);
    assert.match(api.validateScheduleDraft(row('2026-10-27', { sendTime: '16:00', deliveryDate: '2026-10-27' }), weekdays, '2026-10-26').join(), /раньше отправки/);
    assert.match(api.validateScheduleDraft(row('2026-10-27'), weekdays, '2026-10-27').join(), /будущий день/);
});

test('Копирование сдвигает все даты и сохраняет склады, исходник независим', () => {
    const entries = [row('2026-10-27'), row('2026-10-27', { uid: '2', nfile: null, haveDelivery: false, deliveryDate: '' })];
    const copy = api.copyScheduleDrafts(entries, '2026-10-27', '2026-11-04');
    assert.equal(copy[0].sendDate, '2026-11-04');
    assert.equal(copy[0].deliveryDate, '2026-11-05');
    assert.equal(copy[1].nfile, null);
    assert.equal(copy[1].haveDelivery, false);
    copy[0].sendTime = '12:00';
    assert.equal(entries[0].sendTime, '09:00');
    const backwards = api.copyScheduleDrafts(entries, '2026-10-27', '2026-10-26');
    assert.equal(backwards[0].deliveryDate, '2026-10-27');
});

test('Формат CRM содержит часовой пояс, последний интервал заканчивается в 23:59', () => {
    const payload = api.scheduleDraftPayload(row('2026-10-27', { deliveryHour: 23 }), 127);
    assert.match(payload.ordersAcceptedAt, /^2026-10-27T09:00:00[+-]\d\d:\d\d$/);
    assert.match(payload.orderDeliveryIntervalEnd, /^2026-10-28T23:59:00/);
    assert.equal(payload.repeatWeekly, true);
    assert.equal(payload.supplierId, 127);
    assert.equal('id' in payload, false);
    assert.equal(api.scheduleHourLabel(23), '23:00–23:59');
    assert.deepEqual(plain(api.scheduleEventToDraft({ ...payload, nfile: null })).nfile, null);
    assert.throws(() => api.scheduleEventToDraft({ ...payload, orderDeliveryIntervalStart: '2026-10-28T15:30:00' }), /нестандартный/);
});

test('Замена выбирает будущий экземпляр каждого повтора, не затрагивая другой склад', () => {
    const old = event(1, '2026-10-20', { weeklyScheduleId: 50 });
    const first = event(2, '2026-10-27', { weeklyScheduleId: 50 });
    const next = event(3, '2026-11-03', { weeklyScheduleId: 50 });
    const other = event(4, '2026-10-27', { nfile: 8 });
    const once = event(5, '2026-10-27', { weeklyScheduleId: 0 });
    const plan = api.makeSchedulePlan([old, next, first, other, once], [group('2026-10-27', [row()])], { '2026-10-27': 'replace' }, 127, weekdays, '2026-10-26');
    assert.deepEqual(Array.from(plan.operations, operation => [operation.type, operation.event?.id, operation.future]), [
        ['remove', 2, true], ['remove', 5, false], ['create', undefined, undefined]
    ]);
});

test('Все склады обнаруживает и заменяет общие и отдельные правила после выбора замены', () => {
    const plan = api.makeSchedulePlan([event(1, '2026-10-27', { nfile: null }), event(2, '2026-10-27')],
        [group('2026-10-27', [row('2026-10-27', { nfile: null })], [null])], { '2026-10-27': 'replace' }, 127, weekdays, '2026-10-26');
    assert.deepEqual(Array.from(plan.operations.filter(operation => operation.type === 'remove'), operation => operation.event.id), [1, 2]);
});

test('Все склады обнаруживает конфликт даже при отсутствии записей с пустым складом', () => {
    const events = [event(1, '2026-10-27'), event(2, '2026-10-27', { nfile: 8 })];
    const groups = [group('2026-10-27', [row('2026-10-27', { nfile: null })], [null])];
    assert.equal(api.findScheduleConflicts(events, groups)[0].count, 2);
    assert.throws(() => api.makeSchedulePlan(events, groups, {}, 127, weekdays, '2026-10-26'), /Выберите действие/);
    assert.throws(() => api.makeSchedulePlan(events, groups, { '2026-10-27': 'add' }, 127, weekdays, '2026-10-26'), /уже существует/);
});

test('Замена одного склада не удаляет общее правило остальных складов', () => {
    const events = [event(1, '2026-10-27', { nfile: null })];
    const groups = [group('2026-10-27', [row()])];
    assert.equal(api.findScheduleConflicts(events, groups)[0].count, 1);
    assert.throws(() => api.makeSchedulePlan(events, groups, { '2026-10-27': 'replace' }, 127, weekdays, '2026-10-26'), /нельзя удалить/);
    assert.throws(() => api.makeSchedulePlan(events, groups, { '2026-10-27': 'add' }, 127, weekdays, '2026-10-26'), /уже существует/);
});

test('Черновик не допускает отправку всех складов и отдельного склада на одно время', () => {
    const mixed = [group('2026-10-27', [row(), row('2026-10-27', { nfile: null })], [7, null])];
    assert.throws(() => api.makeSchedulePlan([], mixed, {}, 127, weekdays, '2026-10-26'), /пересекающихся складов/);
    const separate = [group('2026-10-27', [row(), row('2026-10-27', { nfile: 8 })], [7, 8])];
    assert.equal(api.makeSchedulePlan([], separate, {}, 127, weekdays, '2026-10-26').operations.length, 2);
});

test('Нельзя сохранить неразрешённый конфликт, дубли или запись вне выбранного склада', () => {
    const entries = [event(1, '2026-10-27')];
    assert.throws(() => api.makeSchedulePlan(entries, [group('2026-10-27', [row()])], {}, 127, weekdays, '2026-10-26'), /действие/);
    assert.throws(() => api.makeSchedulePlan([], [group('2026-10-27', [row(), row()])], {}, 127, weekdays, '2026-10-26'), /две отправки/);
    assert.throws(() => api.makeSchedulePlan([], [group('2026-10-27', [row('2026-10-27', { nfile: 8 })])], {}, 127, weekdays, '2026-10-26'), /вне выбранного/);
    assert.throws(() => api.makeSchedulePlan([], [group('2026-10-27', [row()])], {}, 127, weekdays, '2026-10-27'), /уже наступила/);
});

test('При добавлении одинаковое еженедельное правило не дублируется', () => {
    const events = [event(1, '2026-10-20', { weeklyScheduleId: 50 }), event(2, '2026-10-27', { weeklyScheduleId: 50 })];
    const plan = api.makeSchedulePlan(events, [group('2026-10-27', [row()])], { '2026-10-27': 'add' }, 127, weekdays, '2026-10-26');
    assert.equal(plan.operations.length, 0);
    assert.equal(plan.skipped, 1);
    assert.throws(() => api.makeSchedulePlan(events, [group('2026-10-27', [row('2026-10-27', { deliveryHour: 14 })])], { '2026-10-27': 'add' }, 127, weekdays, '2026-10-26'), /уже существует/);
});

test('Пустой день можно очистить, пропуск не создаёт никаких операций', () => {
    const events = [event(1, '2026-10-27')];
    const groups = [group('2026-10-27', [])];
    assert.equal(api.makeSchedulePlan(events, groups, { '2026-10-27': 'replace' }, 127, weekdays, '2026-10-26').operations[0].type, 'remove');
    assert.equal(api.makeSchedulePlan(events, groups, { '2026-10-27': 'skip' }, 127, weekdays, '2026-10-26').operations.length, 0);
});

test('Замена за пределами загруженных будущих экземпляров блокируется', () => {
    assert.throws(() => api.makeSchedulePlan([event(1, '2026-10-20')], [group('2026-12-01', [row('2026-12-01')])],
        { '2026-12-01': 'replace' }, 127, weekdays, '2026-10-26'), /будущий экземпляр/);
});

test('Историческая запись без будущих экземпляров не считается подтверждением действующего повтора', () => {
    assert.throws(() => api.makeSchedulePlan([event(1, '2026-10-20')], [group('2026-12-01', [row('2026-12-01')])],
        { '2026-12-01': 'add' }, 127, weekdays, '2026-10-26'), /уже существует/);
});

test('Адаптер использует штатные функции и отклоняет ответ другого поставщика', async () => {
    const calls = [];
    const native = { async list(id) { assert.equal(this, native); calls.push(['list', id]); return { data: [event(1, tomorrow())] }; },
        async create(payload) { calls.push(['create', payload]); }, async remove(...args) { calls.push(['remove', ...args]); } };
    const adapter = api.createScheduleAdapter({ $API: { supplier: { schedule: native } } });
    const [entry] = await adapter.list(127);
    await adapter.remove(entry, true);
    assert.deepEqual(calls[1], ['remove', 1, true]);
    native.list = async () => ({ data: [event(2, tomorrow(), { supplierId: 128 })] });
    await assert.rejects(adapter.list(127), /другого поставщика/);
    native.list = async () => ({ data: {} });
    await assert.rejects(adapter.list(127), /неизвестный формат/);
});

test('При потере ответа создание не повторяется, продолжение возможно после сверки', async () => {
    const date = tomorrow();
    const payload = api.scheduleDraftPayload(row(date, { haveDelivery: false }), 127);
    const job = { operations: [{ type: 'create', payload }, { type: 'create', payload: { ...payload, ordersAcceptedAt: api.scheduleTimestamp(date, '10:00') } }],
        index: 0, created: 0, deleted: 0, uncertain: false };
    const saved = []; let calls = 0;
    const adapter = { async create(item) { saved.push({ ...item, id: saved.length + 1, weeklyScheduleId: saved.length + 200 }); calls++; if (calls === 1) throw new Error('Ответ потерян'); },
        async list() { return saved; } };
    await assert.rejects(api.runSchedulePlan(job, adapter, () => {}), /Ответ потерян/);
    assert.equal(job.index, 0);
    await assert.rejects(api.runSchedulePlan(job, adapter, () => {}), /проверьте/);
    assert.equal(calls, 1);
    assert.equal(await api.reconcileSchedulePlan(job, adapter, 127), true);
    await api.runSchedulePlan(job, adapter, () => {});
    assert.equal(calls, 2);
    assert.equal(job.created, 2);
    assert.equal(job.index, 2);
});

test('Неподтверждённая операция остаётся заблокированной, смена поставщика останавливает отправку', async () => {
    const job = { operations: [{ type: 'create', payload: api.scheduleDraftPayload(row(tomorrow(), { haveDelivery: false }), 127) }],
        index: 0, created: 0, deleted: 0, uncertain: true };
    assert.equal(await api.reconcileSchedulePlan(job, { async list() { return []; } }, 127), false);
    assert.equal(job.uncertain, true);
    job.uncertain = false;
    let calls = 0;
    await assert.rejects(api.runSchedulePlan(job, { async create() { calls++; } }, () => { throw new Error('Поставщик изменился'); }), /изменился/);
    assert.equal(calls, 0);
});

test('Отказ 417 показывает ответ CRM и параметры записи без служебных заголовков', async () => {
    const payload = api.scheduleDraftPayload(row(tomorrow()), 127);
    const error = { message: 'Request failed with status code 417', response: { status: 417,
        data: { errors: [{ defaultMessage: 'Причина отказа от сервера' }] }, headers: { Authorization: 'секретный-заголовок' } },
        config: { headers: { Cookie: 'секретный-cookie' } } };
    const job = { operations: [{ type: 'create', payload }], index: 0, created: 0, deleted: 0, uncertain: false };
    await assert.rejects(api.runSchedulePlan(job, { async create() { throw error; } }, () => {}), /HTTP 417/);
    assert.match(job.error, /Причина отказа от сервера/);
    assert.match(job.error, /Склад: 7/);
    assert.match(job.error, /Отправка:/);
    assert.equal(job.index, 0);
    assert.equal(job.uncertain, true);
    assert.doesNotMatch(job.error, /секретный|Authorization|Cookie/);
});

test('Диагностика поддерживает текстовый ответ и ошибку удаления', () => {
    const text = api.describeScheduleRequestError({ response: { status: 417, data: 'Текст сервера' } }, { type: 'remove', event: event(1, tomorrow()) });
    assert.match(text, /удалении/);
    assert.match(text, /Текст сервера/);
    const json = api.describeScheduleRequestError({ response: { status: 417, data: '{"message":"Описание отказа"}' } }, { type: 'create' });
    assert.match(json, /Описание отказа/);
});

test('Сверка удаления проверяет все будущие экземпляры серии', async () => {
    const date = tomorrow(); const target = event(1, date); const remaining = { ...target, id: 2, ordersAcceptedAt: api.scheduleTimestamp(api.addScheduleDays(date, 7), '09:00') };
    const job = { operations: [{ type: 'remove', event: target, future: true, boundary: date }], index: 0, created: 0, deleted: 0, uncertain: true };
    assert.equal(await api.reconcileSchedulePlan(job, { async list() { return [remaining]; } }, 127), false);
    assert.equal(await api.reconcileSchedulePlan(job, { async list() { return []; } }, 127), true);
    assert.equal(job.deleted, 1);
});

test('Календарь обнаруживается через рабочее дерево Vue без __vueParentComponent', () => {
    const element = { parentElement: null };
    const proxy = { $el: element, supplier: { id: 127 } };
    const root = { __vue_app__: { _container: { _vnode: { component: { subTree: { children: [
        { component: { type: { name: 'WorkCalendarQuasar' }, proxy } }
    ] } } } } } };
    const local = setup({ querySelector: () => root });
    assert.equal(local.findScheduleProxy(element), proxy);
});

test('Снимок расписания не зависит от порядка ответа', () => {
    const a = event(1, '2026-10-27'), b = event(2, '2026-10-28');
    assert.equal(api.scheduleFingerprint([a, b]), api.scheduleFingerprint([b, a]));
    assert.notEqual(api.scheduleFingerprint([a]), api.scheduleFingerprint([{ ...a, nfile: 8 }]));
});

test('Очистка охватывает все склады, удаляет повтор один раз и сохраняет сегодняшние и прошлые записи', () => {
    const today = '2026-10-26';
    const events = [
        event(1, '2026-10-19', { weeklyScheduleId: 77 }), event(2, today, { weeklyScheduleId: 77 }),
        event(3, '2026-10-27', { weeklyScheduleId: 88 }), event(4, '2026-11-03', { weeklyScheduleId: 88 }),
        event(5, '2026-11-02', { weeklyScheduleId: 77 }), event(6, '2026-10-28', { weeklyScheduleId: 0, nfile: null }),
        event(7, today, { weeklyScheduleId: 0 }), event(8, '2026-10-25', { weeklyScheduleId: 0 }),
        event(9, '2026-10-27', { weeklyScheduleId: 99, nfile: 8 })
    ];
    const job = api.makeScheduleClearPlan(events, 127, today);
    assert.equal(job.clearing, true);
    assert.equal(job.ruleCount, 3);
    assert.equal(job.onceCount, 1);
    assert.equal(job.futureCount, 5);
    assert.deepEqual(Array.from(job.operations, operation => [operation.event.id, operation.future]), [[3, true], [9, true], [6, false], [5, true]]);
    assert.ok(job.operations.every(operation => operation.type === 'remove' && operation.boundary === '2026-10-27'));
});

test('Очистка пустого или исторического расписания не создаёт запросов удаления', () => {
    assert.equal(api.makeScheduleClearPlan([], 127, '2026-10-26').operations.length, 0);
    const job = api.makeScheduleClearPlan([event(1, '2026-10-26'), event(2, '2026-10-19')], 127, '2026-10-26');
    assert.equal(job.operations.length, 0);
    assert.equal(job.futureCount, 0);
});

test('Очистка отклоняет записи другого поставщика и неполные данные до выполнения операций', () => {
    assert.throws(() => api.makeScheduleClearPlan([event(1, '2026-10-27', { supplierId: 128 })], 127, '2026-10-26'), /другого поставщика/);
    assert.throws(() => api.makeScheduleClearPlan([event(1, '2026-10-27', { id: null })], 127, '2026-10-26'), /отсутствует номер/);
    assert.throws(() => api.makeScheduleClearPlan([event(1, '2026-10-27', { ordersAcceptedAt: 'ошибка' })], 127, '2026-10-26'), /некорректную дату/);
});

test('Очистка после потери ответа сверяет удаление и не отправляет его повторно', async () => {
    const today = api.scheduleDay(), date = tomorrow();
    const history = event(1, api.addScheduleDays(today, -7), { weeklyScheduleId: 70 });
    let events = [history, event(2, date, { weeklyScheduleId: 70 }), event(3, api.addScheduleDays(date, 7), { weeklyScheduleId: 70 }),
        event(4, date, { weeklyScheduleId: 0, nfile: null })];
    const job = api.makeScheduleClearPlan(events, 127, today);
    const calls = [];
    const adapter = {
        async remove(target, future) {
            calls.push([target.id, future]);
            events = events.filter(item => future ? item.weeklyScheduleId !== target.weeklyScheduleId ||
                item.ordersAcceptedAt < target.ordersAcceptedAt : item.id !== target.id);
            if (calls.length === 1) throw new Error('Ответ удаления потерян');
        },
        async list() { return events; }
    };
    await assert.rejects(api.runSchedulePlan(job, adapter, () => {}), /Ответ удаления потерян/);
    assert.equal(await api.reconcileSchedulePlan(job, adapter, 127), true);
    await api.runSchedulePlan(job, adapter, () => {});
    assert.deepEqual(calls, [[2, true], [4, false]]);
    assert.equal(job.deleted, 2);
    assert.deepEqual(events.map(item => item.id), [1]);
});
