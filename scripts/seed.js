/**
 * Наполнение цепочки демонстрационными данными: участники + партии
 * с выпущенными коробками в разных состояниях. Используется для веб-интерфейса.
 *
 * Запуск: npm run seed -- --rpc http://localhost:8545
 *         (перед этим запустите: npx ganache)
 */
const { loadBuild, saveBuild, web3FromRpc, sendTx } = require('./common');

const rpcUrl = process.argv.includes('--rpc')
  ? process.argv[process.argv.indexOf('--rpc') + 1]
  : 'http://localhost:8545';

const secret = (label, i) => `PHARMA-${label}-BOX${i}-${Math.floor(Math.random() * 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;

async function main() {
  const web3 = web3FromRpc(rpcUrl);
  const accounts = await web3.eth.getAccounts();
  if (accounts.length < 4) throw new Error('Нужно минимум 4 аккаунта (ganache даёт 10)');

  const [admin, manufacturer, distributor, pharmacy] = accounts;
  const build = loadBuild();

  const c = new web3.eth.Contract(build.abi);
  const instance = await sendTx(
    c.deploy({ data: build.bytecode }).send({ from: admin, gas: 4_000_000 }),
    'deploy'
  );
  const pharma = new web3.eth.Contract(build.abi, instance.options.address);
  saveBuild({ ...build, address: instance.options.address });

  console.log('Контракт:', instance.options.address);
  console.log('Роли выданы:');
  for (const [addr, role, title] of [
    [manufacturer, 2, 'производитель'],
    [distributor, 3, 'дистрибьютор'],
    [pharmacy, 4, 'аптека'],
  ]) {
    await sendTx(pharma.methods.addParticipant(addr, role).send({ from: admin, gas: 200000 }), 'add');
    console.log(`  ${title}: ${addr}`);
  }

  const expiry = Math.floor(Date.now() / 1000) + 2 * 365 * 24 * 3600;
  const allSecrets = {};

  /// Зарегистрировать партию и выпустить коробки; вернуть { batchId, firstId }.
  const makeBatch = async (name, serial, qty, label) => {
    const rcpt = await sendTx(
      pharma.methods.registerBatch(name, serial, qty, expiry, 'https://proizvoditel.example/instrukciya')
        .send({ from: manufacturer, gas: 600000 }),
      'register ' + name
    );
    const batchId = rcpt.events.BatchRegistered.returnValues.batchId;
    const secrets = Array.from({ length: qty }, (_, i) => secret(label, i + 1));
    const mrcpt = await sendTx(
      pharma.methods.mintUnits(batchId, secrets.map((s) => web3.utils.keccak256(s)))
        .send({ from: manufacturer, gas: 4_000_000 }),
      'mint ' + name
    );
    const firstId = Number(mrcpt.events.UnitsMinted.returnValues.firstTokenId);
    allSecrets[label] = { batchId, firstId, secrets };
    return { batchId, firstId, secrets };
  };

  // Партия 1: в аптеке, одна коробка продана (демо детектора подделки).
  const s1 = await makeBatch('Парацетамол 500 мг', 'PCT-2026-0001', 8, 'A1B2C3');
  await sendTx(pharma.methods.transferCustody(s1.batchId, distributor).send({ from: manufacturer, gas: 200000 }), '→d');
  await sendTx(pharma.methods.transferCustody(s1.batchId, pharmacy).send({ from: distributor, gas: 200000 }), '→p');
  await sendTx(pharma.methods.markSold(s1.firstId).send({ from: pharmacy, gas: 200000 }), 'sold box 1');

  // Партия 2: только зарегистрирована, коробки на складе производителя.
  const s2 = await makeBatch('Амоксициллин 250 мг', 'AMX-2026-0014', 5, 'D4E5F6');

  // Партия 3: отозвана производителем (одна коробка была продана до отзыва).
  const s3 = await makeBatch('Ибупрофен 400 мг', 'IBU-2026-0007', 4, '77AA90');
  await sendTx(pharma.methods.transferCustody(s3.batchId, pharmacy).send({ from: manufacturer, gas: 200000 }), '→p');
  await sendTx(pharma.methods.markSold(s3.firstId).send({ from: pharmacy, gas: 200000 }), 'sold');
  await sendTx(
    pharma.methods.recallBatch(s3.batchId, 'Отклонение по содержанию действующего вещества').send({ from: manufacturer, gas: 200000 }),
    'recall'
  );

  console.log('\nДемо-данные (секреты коробок — для проверки в веб-интерфейсе):');
  const show = (label, name, note) => {
    const s = allSecrets[label];
    console.log(`  Партия #${s.batchId} «${name}» — ${note}`);
    console.log(`    коробка tokenId ${s.firstId}:     ${s.secrets[0]}`);
    console.log(`    коробка tokenId ${s.firstId + 1}: ${s.secrets[1]}`);
  };
  show('A1B2C3', 'Парацетамол 500 мг', 'в аптеке; коробка №1 УЖЕ ПРОДАНА (детектор подделки: «новая» с этим кодом = копия)');
  show('D4E5F6', 'Амоксициллин 250 мг', 'на складе производителя');
  show('77AA90', 'Ибупрофен 400 мг', 'ОТОЗВАНА (брак), одна коробка была продана до отзыва');
  console.log('\nОткройте http://localhost:8080, подключитесь к', rpcUrl, 'и введите адрес контракта.');
}

main().catch((err) => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});
