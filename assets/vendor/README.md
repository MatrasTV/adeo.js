# Библиотеки анализа Excel

Эти исходники встроены в `adeo.user.js`, чтобы рабочему ПК не требовался доступ к внешним адресам во время анализа. Пользователь устанавливает только полный `adeo.user.js`; копировать эту папку на его компьютер не нужно.

| Файл | Версия | Исходный адрес | Лицензия |
| --- | --- | --- | --- |
| `xlsx-0.20.3.js` | SheetJS 0.20.3 | https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js | `SheetJS-LICENSE.txt`, Apache-2.0 |
| `decimal-10.6.0.js` | decimal.js 10.6.0 | https://cdn.jsdelivr.net/npm/decimal.js@10.6.0/decimal.js | `decimal-LICENCE.md`, MIT |

Исходники библиотек сохранены без изменений. После обновления файлов выполните из корня проекта:

```powershell
node scripts/bundle-analysis.cjs
node scripts/bundle-analysis.cjs --check
node --check adeo.user.js
```

Первый вызов встраивает исходники вместе с полными текстами лицензий. Второй проверяет, что встроенные копии актуальны. Сеть при сборке и проверке не используется.
