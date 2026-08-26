// Topic discovery for the daily blog generator.
//
// Regression context: the generator used to pick from a fixed 13-entry list and
// nothing else. Once every entry was covered it logged `backlog exhausted` and
// exited — every day from 2026-07-27 to 2026-08-19, 24 days with no post and no
// alert. These tests pin the two things that failure taught us: seeds are still
// preferred while they last, and running out of seeds must NOT be the end of the
// road.
const assert = require('node:assert');
const test = require('node:test');

process.env.BLOG_API_KEY = process.env.BLOG_API_KEY || 'test-key';

const {
  parseTopicCandidates,
  pickTopic,
  topicDiscoveryPrompt,
  slugify,
  SEED_TOPICS,
} = require('../services/blog-generator.js');

const asCovered = (titles) => titles.map((t) => ({ topicKey: slugify(t), title: t }));
const allSeedsCovered = () => asCovered(SEED_TOPICS);
const reply = (topics) => () => JSON.stringify({ topics });

test('parseTopicCandidates: reads a clean JSON reply', () => {
  const out = parseTopicCandidates('{"topics":["Quanto custa manter um carro eletrico por ano","Carregador solar para condominio vale a pena"]}');
  assert.deepStrictEqual(out, [
    'Quanto custa manter um carro eletrico por ano',
    'Carregador solar para condominio vale a pena',
  ]);
});

test('parseTopicCandidates: tolerates prose around the JSON', () => {
  const out = parseTopicCandidates('Claro! Aqui estao:\n{"topics":["Como planejar uma viagem longa de carro eletrico"]}\nEspero ter ajudado.');
  assert.deepStrictEqual(out, ['Como planejar uma viagem longa de carro eletrico']);
});

test('parseTopicCandidates: drops non-strings and blank entries', () => {
  const out = parseTopicCandidates(JSON.stringify({ topics: [null, 42, { t: 'x' }, [], '   ', 'Bateria de carro eletrico dura quantos anos'] }));
  assert.deepStrictEqual(out, ['Bateria de carro eletrico dura quantos anos']);
});

test('parseTopicCandidates: drops titles too short to be a topic', () => {
  const out = parseTopicCandidates(JSON.stringify({ topics: ['Recarga', 'IPVA 2026', 'Quanto tempo dura a bateria de um carro eletrico'] }));
  assert.deepStrictEqual(out, ['Quanto tempo dura a bateria de um carro eletrico']);
});

test('parseTopicCandidates: drops an all-punctuation entry that would slugify to nothing', () => {
  const out = parseTopicCandidates(JSON.stringify({ topics: ['??? !!! ??? !!! ???', 'Carro eletrico em viagem de familia no litoral'] }));
  assert.deepStrictEqual(out, ['Carro eletrico em viagem de familia no litoral']);
});

test('parseTopicCandidates: collapses candidates that share a slug', () => {
  // The covered_topics ledger is keyed by slug. Two titles with the same slug
  // would look like one topic and the second could never be written.
  const out = parseTopicCandidates(JSON.stringify({ topics: ['Recarga rapida DC no Brasil!!!', 'recarga rapida dc no brasil'] }));
  assert.strictEqual(out.length, 1);
});

test('parseTopicCandidates: normalises whitespace and caps the length', () => {
  const long = 'Quanto custa ' + 'muito '.repeat(60) + 'carregar';
  const [only] = parseTopicCandidates(JSON.stringify({ topics: [`  Como   escolher\n\tum carregador para casa  `, long] }));
  assert.strictEqual(only, 'Como escolher um carregador para casa');
  const [, capped] = parseTopicCandidates(JSON.stringify({ topics: ['Como escolher um carregador para casa', long] }));
  assert.ok(capped.length <= 140);
});

test('parseTopicCandidates: returns empty for garbage instead of throwing', () => {
  for (const bad of ['', 'desculpe, nao consigo', '{"topics": "nao e array"}', '{broken', null, undefined]) {
    assert.deepStrictEqual(parseTopicCandidates(bad), [], `input: ${JSON.stringify(bad)}`);
  }
});

test('pickTopic: takes the first uncovered seed, in order', () => {
  const picked = pickTopic([], '', () => assert.fail('must not call the model while seeds remain'));
  assert.deepStrictEqual(picked, { topic: SEED_TOPICS[0], source: 'seed' });
});

test('pickTopic: skips covered seeds', () => {
  const picked = pickTopic(asCovered(SEED_TOPICS.slice(0, 3)), '', () => assert.fail('must not call the model while seeds remain'));
  assert.strictEqual(picked.topic, SEED_TOPICS[3]);
  assert.strictEqual(picked.source, 'seed');
});

test('pickTopic: falls back to discovery once every seed is covered', () => {
  const picked = pickTopic(allSeedsCovered(), '', reply(['Quanto custa manter um carro eletrico por ano no Brasil']));
  assert.deepStrictEqual(picked, {
    topic: 'Quanto custa manter um carro eletrico por ano no Brasil',
    source: 'discovered',
  });
});

test('pickTopic: discovery result is still deduped against the ledger', () => {
  const covered = allSeedsCovered().concat(asCovered(['Quanto custa manter um carro eletrico por ano no Brasil']));
  const picked = pickTopic(covered, '', reply([
    'Quanto custa manter um carro eletrico por ano no Brasil',
    'Bateria de carro eletrico perde quanto de capacidade por ano',
  ]));
  assert.strictEqual(picked.topic, 'Bateria de carro eletrico perde quanto de capacidade por ano');
});

test('pickTopic: null when every proposed topic is already covered', () => {
  const covered = allSeedsCovered().concat(asCovered(['Bateria de carro eletrico dura quantos anos']));
  assert.strictEqual(pickTopic(covered, '', reply(['Bateria de carro eletrico dura quantos anos'])), null);
});

test('pickTopic: null when discovery returns nothing usable', () => {
  assert.strictEqual(pickTopic(allSeedsCovered(), '', () => 'desculpe, nao consigo ajudar'), null);
});

test('pickTopic: a throwing model call is caught, not propagated', () => {
  // The daily job must record a skip, not crash and lose the run.
  assert.strictEqual(
    pickTopic(allSeedsCovered(), '', () => { throw new Error('claude failed: timeout'); }),
    null,
  );
});

test('pickTopic: tolerates a missing/empty covered ledger', () => {
  assert.strictEqual(pickTopic(undefined, '', () => assert.fail('seeds remain')).source, 'seed');
  assert.strictEqual(pickTopic(null, '', () => assert.fail('seeds remain')).source, 'seed');
});

test('topicDiscoveryPrompt: lists covered titles so paraphrases are avoided', () => {
  // Slug dedup alone cannot catch "IPVA para eletricos" vs "Isencao de IPVA
  // para carros eletricos" — the model has to see the titles.
  const p = topicDiscoveryPrompt(['IPVA para carros eletricos'], '');
  assert.ok(p.includes('IPVA para carros eletricos'));
  assert.ok(/JÁ PUBLICAMOS/.test(p));
});

test('topicDiscoveryPrompt: omits the covered block when nothing is published', () => {
  assert.ok(!/JÁ PUBLICAMOS/.test(topicDiscoveryPrompt([], '')));
});

test('topicDiscoveryPrompt: carries the brand guidelines through', () => {
  assert.ok(topicDiscoveryPrompt([], 'Nunca desencoraje a recarga publica.').includes('Nunca desencoraje a recarga publica.'));
});

test('topicDiscoveryPrompt: asks for JSON and bans the em dash', () => {
  const p = topicDiscoveryPrompt([], '');
  assert.ok(p.includes('{"topics"'));
  assert.ok(/travess/i.test(p));
});

test('SEED_TOPICS: no duplicate slugs (a dupe would silently skip a topic)', () => {
  const slugs = SEED_TOPICS.map(slugify);
  assert.strictEqual(new Set(slugs).size, slugs.length);
  assert.ok(slugs.every(Boolean));
});
