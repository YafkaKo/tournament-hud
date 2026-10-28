/**
 * Меню тестовых данных для start-test-data.bat.
 * Русский текст выводит Node, а не cmd.exe: так он не ломается
 * ни на какой версии Windows и ни в какой кодировке консоли.
 */

const readline = require('readline');
const path = require('path');
const { spawn } = require('child_process');

// Каждый запуск драфта для анимации пика — с новым номером матча:
// сервер не повторяет пики, которые уже видел в этом матче.
const freshMatch = `--match=79${String(Date.now()).slice(-8)}`;

const MODES = {
  1: { title: 'Dota 2: матч в разгаре', script: 'mock-gsi.js', args: [] },
  2: { title: 'Dota 2: стадия драфта', script: 'mock-gsi.js', args: ['--draft'] },
  3: { title: 'Dota 2: конец карты (итоги, потом выход в меню)', script: 'mock-gsi.js', args: ['--end'] },
  4: { title: 'Dota 2: быстрая игра x10 с паузами (сравнение вероятности, подсказка о рекламе)', script: 'mock-gsi.js', args: ['--speed=10', '--pause'] },
  5: { title: 'Dota 2: новая карта с другим matchid', script: 'mock-gsi.js', args: ['--match=7900000002'] },
  6: { title: 'Dota 2: быстрый драфт — проверка анимации пика', script: 'mock-gsi.js', args: ['--draft', '--speed=4', freshMatch] },
  7: { title: 'CS2: матч с первого раунда', script: 'mock-cs2.js', args: [] },
  8: { title: 'CS2: конец первой половины (смена сторон)', script: 'mock-cs2.js', args: ['--round=11'] },
  9: { title: 'CS2: разминка, затем матч', script: 'mock-cs2.js', args: ['--warmup'] },
  10: { title: 'CS2: быстрый прогон x4', script: 'mock-cs2.js', args: ['--speed=4'] }
};

console.log('');
console.log('  Что имитировать вместо игры (на пульте выберите эту же игру):');
for (const [n, m] of Object.entries(MODES)) console.log(`    ${n} — ${m.title}`);
console.log('');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('  Номер (Enter = 1): ', (answer) => {
  rl.close();
  const mode = MODES[answer.trim()] || MODES[1];
  console.log(`\n  Запускаю: ${mode.title}\n`);
  const child = spawn(process.execPath, [path.join(__dirname, mode.script), ...mode.args], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
});
