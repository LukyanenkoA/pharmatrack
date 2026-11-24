/**
 * Деплой контракта PharmaTrack на указанную сеть (стиль лекции 4,
 * страницы 31–32: web3.eth.Contract.deploy().send()).
 *
 * Запуск:
 *   npm run deploy                       — встроенный ganache (для быстрого старта)
 *   npm run deploy -- --rpc http://localhost:8545      — geth --dev / ganache CLI
 *   npm run deploy -- --rpc <sepolia-rpc> --key <приватный ключ>
 *
 * Адрес задеплоенного контракта сохраняется в build/PharmaTrack.json
 * и печатается в консоль.
 */
const { loadBuild, saveBuild, web3FromRpc, web3EmbeddedGanache, sendTx } = require('./common');

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const rpcUrl = argValue('--rpc', null);
  const privateKey = argValue('--key', null);

  let web3, provider, from;
  if (rpcUrl) {
    web3 = web3FromRpc(rpcUrl);
    provider = null;
    if (privateKey) {
      const account = web3.eth.accounts.privateKeyToAccount(
        privateKey.startsWith('0x') ? privateKey : '0x' + privateKey
      );
      web3.eth.accounts.wallet.add(account);
      from = account.address;
    } else {
      const accounts = await web3.eth.getAccounts();
      if (accounts.length === 0) throw new Error('На узле нет разблокированных аккаунтов — укажите --key');
      from = accounts[0];
    }
  } else {
    ({ web3, provider, accounts } = await web3EmbeddedGanache());
    from = accounts[0].address;
  }

  const build = loadBuild();
  const chainId = await web3.eth.getChainId();
  console.log(`Сеть: ${rpcUrl || 'встроенный ganache'} (chainId ${chainId})`);
  console.log(`Деплой от адреса: ${from}`);

  const contract = new web3.eth.Contract(build.abi);
  const instance = await sendTx(
    contract.deploy({ data: build.bytecode }).send({ from, gas: 4_000_000 }),
    'deploy'
  );
  const address = instance.options.address;

  saveBuild({ ...build, address, chainId });
  console.log('\nКонтракт задеплоен!');
  console.log('  Адрес:', address);
  if (provider) await provider.close ? provider.close() : process.exit(0);
}

main().catch((err) => {
  console.error('Ошибка деплоя:', err.message);
  process.exit(1);
});
