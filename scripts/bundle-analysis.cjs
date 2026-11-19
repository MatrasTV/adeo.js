const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

// Встраиваем проверенные версии библиотек в единый установочный файл без сетевых зависимостей анализа.
const root = resolve(__dirname, '..');
const target = resolve(root, 'adeo.user.js');
const libraries = [
    ['assets/vendor/SheetJS-LICENSE.txt', 'assets/vendor/xlsx-0.20.3.js'],
    ['assets/vendor/decimal-LICENCE.md', 'assets/vendor/decimal-10.6.0.js']
];
const sources = libraries.map(([license, script]) => {
    const notice = readFileSync(resolve(root, license), 'utf8').replace(/\*\//g, '* /');
    return `/*\n${notice}\n*/\n${readFileSync(resolve(root, script), 'utf8')}`;
}).join('\n;\n');
const literal = JSON.stringify(sources).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
let source = readFileSync(target, 'utf8');
const eol = source.includes('\r\n') ? '\r\n' : '\n';
const block = [
    '    // НАЧАЛО ВСТРОЕННЫХ БИБЛИОТЕК АНАЛИЗА',
    '    // Создано scripts/bundle-analysis.cjs. Версии и лицензии находятся в assets/vendor.',
    '    function getRelevanceWorkerSources() {',
    `        return ${literal};`,
    '    }',
    '    // КОНЕЦ ВСТРОЕННЫХ БИБЛИОТЕК АНАЛИЗА'
].join(eol);
const existing = /    \/\/ НАЧАЛО ВСТРОЕННЫХ БИБЛИОТЕК АНАЛИЗА[\s\S]*?    \/\/ КОНЕЦ ВСТРОЕННЫХ БИБЛИОТЕК АНАЛИЗА/;
if (existing.test(source)) source = source.replace(existing, () => block);
else {
    const ending = source.lastIndexOf('})();');
    if (ending < 0) throw new Error('Не найден конец основного скрипта.');
    source = source.slice(0, ending) + block + eol + source.slice(ending);
}
if (process.argv.includes('--check')) {
    if (source !== readFileSync(target, 'utf8')) throw new Error('Встроенные библиотеки устарели. Выполните node scripts/bundle-analysis.cjs.');
    console.log('Встроенные библиотеки актуальны.');
} else {
    writeFileSync(target, source, 'utf8');
    console.log('Библиотеки встроены в adeo.user.js.');
}
