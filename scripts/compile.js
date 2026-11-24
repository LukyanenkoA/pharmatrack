/**
 * Компиляция контракта PharmaTrack.sol → build/PharmaTrack.json (ABI + байт-код).
 * Аналог команды из лекции 4: solc PharmaTrack.sol --combined-json abi,bin
 * но через solcjs, чтобы не требовать установки solc в системе.
 *
 * Запуск: npm run compile
 */
const fs = require('fs');
const path = require('path');
const solc = require('solc');
const { saveBuild } = require('./common');

const contractPath = path.resolve(__dirname, '../contracts/PharmaTrack.sol');
const source = fs.readFileSync(contractPath, 'utf8');

const input = {
  language: 'Solidity',
  sources: { 'PharmaTrack.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    // paris: без опкода PUSH0 (EIP-3855), чтобы байт-код работал в ganache 7
    // и старых узлах geth (лекционный стек). Solidity >= 0.8.20 иначе эмитит PUSH0.
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

console.log(`Компиляция ${path.relative(process.cwd(), contractPath)} (solc ${solc.version()})...`);
const output = JSON.parse(solc.compile(JSON.stringify(input)));

const errors = (output.errors || []).filter((e) => e.severity === 'error');
if (errors.length > 0) {
  for (const e of errors) console.error(e.formattedMessage);
  process.exit(1);
}
for (const w of output.errors || []) {
  if (w.severity === 'warning') console.warn('Предупреждение:', w.formattedMessage);
}

const compiled = output.contracts['PharmaTrack.sol']['PharmaTrack'];
saveBuild({
  contractName: 'PharmaTrack',
  compiler: solc.version(),
  abi: compiled.abi,
  bytecode: '0x' + compiled.evm.bytecode.object,
});

// ABI для фронтенда (docs/abi.json), чтобы страница работала без сборки.
fs.mkdirSync(path.resolve(__dirname, '../docs'), { recursive: true });
fs.writeFileSync(
  path.resolve(__dirname, '../docs/abi.json'),
  JSON.stringify(compiled.abi)
);

console.log('Готово: build/PharmaTrack.json (ABI + байт-код), docs/abi.json (для фронтенда)');
