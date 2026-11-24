// Настройки фронтенда PharmaTrack.
window.PHARMA_CONFIG = {
  // Адрес задеплоенного контракта (0x…). После деплоя в Sepolia впишите его сюда —
  // тогда страница на GitHub Pages будет работать без ручного ввода адреса.
  contractAddress: '',

  // Публичный RPC тестовой сети Sepolia: проверка подлинности без кошелька.
  defaultRpc: 'https://ethereum-sepolia-rpc.publicnode.com',

  // RPC локальной цепочки для демо (npx ganache или geth --dev, лекция 4).
  localRpc: 'http://localhost:8545',
};
