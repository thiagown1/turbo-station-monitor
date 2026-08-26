const { generateSuggestion } = require('./lib/copilot');
const { db } = require('./lib/db');

(async () => {
  try {
    const fakeConv = {
      id: 'test_local_01',
      brand_id: 'turbo_station',
      customer_phone: '5561999887766',
      customer_name: 'Teste Local',
      status: 'open',
      created_at: new Date().toISOString(),
      channel: 'test',
    };
    const messages = [
      { direction: 'inbound', body: 'Meu carro tá preso no carregador e não sai por nada, me ajuda logo!', created_at: new Date().toISOString() }
    ];
    const userData = { displayName: 'Teste Local', credits: 5000 };
    console.log("Generating suggestion...");
    const result = await generateSuggestion(fakeConv, messages, { userData, tags: ['client-simulation'] });
    console.log("Result:", result);
  } catch(e) { console.error(e); }
})();
