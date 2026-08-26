// Internal-link sanitisation for generated blog posts.
//
// Regression context: the writer prompt tells the model to link 1-2 published
// posts as [titulo](/blog/slug), and the editor prompt simultaneously rejected
// any draft using "rotas inexistentes (as unicas validas sao /, /blog e
// /#contato)". Those two rules contradict each other, and once dynamic topic
// discovery started producing posts again the editor held two consecutive days
// (2026-08-21 and 2026-08-22) for linking posts that DO exist.
//
// The fix moves the whole question out of the editor's hands: whether a slug is
// published is a fact, so code decides it, deterministically, before the editor
// ever sees the draft. These tests pin that contract.
const assert = require('node:assert');
const test = require('node:test');

process.env.BLOG_API_KEY = process.env.BLOG_API_KEY || 'test-key';

const { sanitizeInternalLinks, VALID_STATIC_ROUTES, runRevise } = require('../services/blog-generator.js');

const related = [
    { slug: 'recarga-dc-vs-ac-diferencas-e-quando-usar-cada-uma', title: 'Recarga DC vs AC' },
    { slug: 'carregador-em-condominio-regras-custo-e-instalacao', title: 'Carregador em condominio' },
];

const keeps = (md) => assert.strictEqual(sanitizeInternalLinks(md, related), md);

test('keeps a link to a published post (the exact case that was being rejected)', () => {
    keeps('Veja [Recarga DC vs AC](/blog/recarga-dc-vs-ac-diferencas-e-quando-usar-cada-uma) para entender.');
});

test('keeps links to every route that really exists', () => {
    for (const route of VALID_STATIC_ROUTES) {
        keeps(`Veja [texto](${route}) aqui.`);
    }
});

test('keeps /faq and /parceiro, which the old prompt wrongly forbade', () => {
    keeps('Duvidas comuns no [FAQ](/faq).');
    keeps('Quer hospedar? [Veja como](/parceiro/ganhe-com-estacoes).');
});

test('unwraps a link to a slug that is not published', () => {
    assert.strictEqual(
        sanitizeInternalLinks('Leia [um post](/blog/nao-existe-esse-slug) aqui.', related),
        'Leia um post aqui.',
    );
});

test('unwraps invented static routes that return 404 in production', () => {
    // The gap this fix closes: the old sanitiser only looked at /blog/, so an
    // invented /contato survived it AND would now survive the editor too.
    for (const bad of ['/contato', '/sobre', '/estacoes', '/precos', '/app']) {
        assert.strictEqual(
            sanitizeInternalLinks(`Fale pelo [contato](${bad}).`, related),
            'Fale pelo contato.',
            `deveria remover ${bad}`,
        );
    }
});

test('unwraps a published slug carrying a query or trailing segment', () => {
    // Conservative on purpose: only the bare canonical path is provably real.
    for (const href of [
        '/blog/recarga-dc-vs-ac-diferencas-e-quando-usar-cada-uma/',
        '/blog/recarga-dc-vs-ac-diferencas-e-quando-usar-cada-uma?utm=x',
        '/blog/recarga-dc-vs-ac-diferencas-e-quando-usar-cada-uma/amp',
    ]) {
        assert.strictEqual(sanitizeInternalLinks(`[t](${href})`, related), 't', `deveria remover ${href}`);
    }
});

test('leaves external links completely alone', () => {
    keeps('Segundo a [ANEEL](https://www.aneel.gov.br), a regra e essa.');
    keeps('Veja o [manual](http://exemplo.com/manual.pdf).');
});

test('normalizes relative internal links before validating them', () => {
    assert.strictEqual(sanitizeInternalLinks('[FAQ](faq)', related), '[FAQ](/faq)');
    assert.strictEqual(
        sanitizeInternalLinks('[Post](blog/recarga-dc-vs-ac-diferencas-e-quando-usar-cada-uma)', related),
        '[Post](/blog/recarga-dc-vs-ac-diferencas-e-quando-usar-cada-uma)',
    );
    assert.strictEqual(sanitizeInternalLinks('[Contato](contato)', related), 'Contato');
    assert.strictEqual(sanitizeInternalLinks('[Fantasma](blog/nao-publicado)', related), 'Fantasma');
});

test('leaves protocol-relative external links completely alone', () => {
    keeps('Segundo a [ANEEL](//www.aneel.gov.br), a regra e essa.');
});

test('validates internal links that carry an optional Markdown title', () => {
    assert.strictEqual(
        sanitizeInternalLinks('[FAQ](faq "Dúvidas frequentes")', related),
        '[FAQ](/faq "Dúvidas frequentes")',
    );
    assert.strictEqual(
        sanitizeInternalLinks('[Contato](/contato "Fale conosco")', related),
        'Contato',
    );
    keeps('[ANEEL](https://www.aneel.gov.br "Agência reguladora")');
});

test('validates absolute links that target the Turbo Station public site', () => {
    assert.strictEqual(
        sanitizeInternalLinks('[Contato](https://www.turbostation.com.br/contato)', related),
        'Contato',
    );
    assert.strictEqual(sanitizeInternalLinks('[Contato](//www.turbostation.com.br/contato)', related), 'Contato');
    keeps('[FAQ](https://www.turbostation.com.br/faq)');
    keeps('[FAQ](//www.turbostation.com.br/faq)');
    keeps('[ANEEL](https://www.aneel.gov.br/contato)');
});

test('does not mangle an image whose path is invalid', () => {
    // Without the `!` lookbehind this produced a dangling "!alt" in the body.
    const md = '![diagrama](/imagens/nao-existe.png)';
    assert.strictEqual(sanitizeInternalLinks(md, related), md);
});

test('does not reinterpret a clickable image as an ordinary text link', () => {
    for (const md of [
        '[![diagrama](/imagens/mapa.png)](/faq)',
        '[![diagrama](/imagens/mapa.png)](/contato)',
    ]) {
        assert.strictEqual(sanitizeInternalLinks(md, related), md);
    }
});

test('handles several links in one body, keeping the good and dropping the bad', () => {
    const out = sanitizeInternalLinks(
        'Veja [A](/blog/recarga-dc-vs-ac-diferencas-e-quando-usar-cada-uma), [B](/blog/inventado) e o [FAQ](/faq).',
        related,
    );
    assert.ok(out.includes('](/blog/recarga-dc-vs-ac-diferencas-e-quando-usar-cada-uma)'));
    assert.ok(out.includes('](/faq)'));
    assert.ok(!out.includes('/blog/inventado'));
    assert.ok(out.includes(', B e o '), 'o texto do link removido deve permanecer na frase');
});

test('is safe with no related posts and with empty input', () => {
    assert.strictEqual(sanitizeInternalLinks('[t](/blog/qualquer)', []), 't');
    assert.strictEqual(sanitizeInternalLinks('[t](/blog/qualquer)', undefined), 't');
    assert.strictEqual(sanitizeInternalLinks('', related), '');
    assert.strictEqual(sanitizeInternalLinks('sem link nenhum', related), 'sem link nenhum');
});

test('the editor is no longer told to police internal routes', () => {
    // The contradiction itself: if this string comes back, the editor starts
    // holding valid posts again.
    const src = require('node:fs').readFileSync(
        require('node:path').join(__dirname, '../services/blog-generator.js'),
        'utf8',
    );
    const editorPrompt = src.slice(src.indexOf('function editorPrompt'), src.indexOf('async function recordRun'));
    assert.ok(
        !/as únicas válidas são/.test(editorPrompt),
        'o prompt do editor voltou a listar rotas validas, o que contradiz o prompt do redator',
    );
    assert.ok(
        /já foi validado por código/.test(editorPrompt),
        'o editor deve ser informado de que os links ja foram validados por codigo',
    );
});

test('revision sanitizes internal links before editor review and storage', async () => {
    const revisedMarkdown = `---
title: "Post revisado"
description: "Uma descrição suficientemente clara para o teste"
category: "Guias"
tags: ["recarga"]
---
Veja o [post publicado](/blog/publicado), o [contato inventado](/contato) e o [post inexistente](/blog/fantasma).`;
    let editorInput = '';
    let savedPost = null;

    const request = async (method, route, body) => {
        if (method === 'GET' && route === '/config') return { guidelines: '' };
        if (method === 'GET' && route === '/admin/posts/post-atual') {
            return {
                title: 'Post atual', body: 'corpo antigo', date: '2026-08-22',
                description: 'descrição', category: 'Guias', tags: [], status: 'draft', draft: true,
            };
        }
        if (method === 'GET' && route === '/posts') {
            return { posts: [{ slug: 'publicado', title: 'Post publicado' }] };
        }
        if (method === 'POST' && route === '/posts') {
            savedPost = body;
            return { ok: true };
        }
        throw new Error(`unexpected request ${method} ${route}`);
    };
    const ask = (prompt) => {
        if (prompt.includes('Você é editor-chefe')) {
            editorInput = prompt;
            return JSON.stringify({ approved: true, reasons: [], fixes: [] });
        }
        return revisedMarkdown;
    };

    await runRevise('post-atual', { request, ask, record: async () => {} });

    assert.ok(editorInput.includes('](/blog/publicado)'), 'published link reaches the editor');
    assert.ok(!editorInput.includes('](/contato)'), 'invalid static route is removed before review');
    assert.ok(!editorInput.includes('](/blog/fantasma)'), 'unpublished slug is removed before review');
    assert.ok(savedPost.body.includes('](/blog/publicado)'));
    assert.ok(!savedPost.body.includes('](/contato)'));
    assert.ok(!savedPost.body.includes('](/blog/fantasma)'));
    assert.match(savedPost.body, /contato inventado/);
    assert.match(savedPost.body, /post inexistente/);
});
