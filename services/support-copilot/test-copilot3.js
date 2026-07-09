const { generateSuggestion } = require('./lib/copilot');
const { db } = require('./lib/db');

(async () => {
  try {
    const fakeConv = {
      id: 'test_angry_01',
      brand_id: 'turbo_station',
      customer_phone: '5561999887766',
      customer_name: 'Ana',
      status: 'open',
      created_at: new Date().toISOString(),
      channel: 'test',
    };
    const messages = [
      { direction: 'inbound', body: 'Vocês são um lixo, cobraram 50 reais de mim e não carregou bosta nenhuma!! Devolve meu dinheiro!!', created_at: new Date().toISOString() }
    ];
    const userData = null;
    console.log("Generating suggestion...");
    const result = await generateSuggestion(fakeConv, messages, { userData, tags: ['angry-customer'] });
    console.log("Result:", result);
  } catch(e) { console.error(e); }
})();
