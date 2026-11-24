/**
 * Общие помощники для скриптов PharmaTrack (web3.js, как в лекциях 4–5).
 */
const fs = require('fs');
const path = require('path');
const Web3 = require('web3');

const BUILD_DIR = path.resolve(__dirname, '../build');
const BUILD_FILE = path.join(BUILD_DIR, 'PharmaTrack.json');

/** Загрузить скомпилированный контракт (ABI + байт-код + адрес деплоя). */
function loadBuild() {
  if (!fs.existsSync(BUILD_FILE)) {
    throw new Error('Не найден build/PharmaTrack.json — сначала запустите: npm run compile');
  }
  return JSON.parse(fs.readFileSync(BUILD_FILE, 'utf8'));
}

/** Сохранить артефакты сборки. */
function saveBuild(data) {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.writeFileSync(BUILD_FILE, JSON.stringify(data, null, 2));
}

/** Создать web3 для внешнего RPC (geth --dev, ganache CLI, Sepolia...). */
function web3FromRpc(rpcUrl) {
  return new Web3(new Web3.providers.HttpProvider(rpcUrl));
}

/** Создать web3 на встроенном в процессе ganache (без внешних зависимостей). */
async function web3EmbeddedGanache() {
  const ganache = require('ganache');
  const provider = ganache.provider({ seed: 'pharmatrack', logging: { quiet: true } });
  const web3 = new Web3(provider);
  const initial = await provider.getInitialAccounts();
  // Ключи объекта — адреса, значения — { secretKey, balance, nonce }.
  const accounts = Object.entries(initial).map(([address, info]) => ({
    address,
    secretKey: info.secretKey,
  }));
  return { web3, provider, accounts };
}

/** Экземпляр контракта по адресу деплоя. */
function contractAt(web3, addressOverride) {
  const build = loadBuild();
  const address = addressOverride || build.address;
  if (!address) throw new Error('Адрес контракта неизвестен — сначала запустите: npm run deploy');
  return new web3.eth.Contract(build.abi, address);
}

/**
 * Дождаться подтверждения и вернуть результат: receipt для обычных
 * транзакций или экземпляр контракта для deploy().send().
 */
async function sendTx(promise, label) {
  const result = await promise;
  if (result && result.status === false) {
    throw new Error(`Транзакция отклонена: ${label} (tx ${result.transactionHash})`);
  }
  return result;
}

const STATUS_NAMES = ['Created', 'InTransit', 'AtPharmacy', 'Sold', 'Recalled'];
const ROLE_NAMES = ['None', 'Admin', 'Manufacturer', 'Distributor', 'Pharmacy'];

module.exports = {
  loadBuild,
  saveBuild,
  web3FromRpc,
  web3EmbeddedGanache,
  contractAt,
  sendTx,
  STATUS_NAMES,
  ROLE_NAMES,
  BUILD_FILE,
};
