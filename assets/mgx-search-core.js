/**
 * Shared search matcher (window.mgxSearchCore), used by the collection search bar
 * (assets/collection-search.js) and the search overlay (assets/mgx-search.js), so both
 * find the same products for the same words.
 *
 * Covers: umlaut and accent folding (für = fuer), brand and note synonyms (ysl, mfk, vanille),
 * tag values (marke:tom-ford -> "tom ford"), scent numbers with and without leading zeros,
 * word-start matching for short terms and a fallback for words typed together ("tomford").
 *
 * API:
 *   fold(str)                      folded text ("Kölner Wasser" -> "koelner wasser")
 *   parseQuery(raw)                { terms, compact }
 *   buildHay(title, extra, tags)   { hay, compact }; tags: array or "a|b" string
 *   matches(entry, query)          entry from buildHay
 *   score(item, query)             item from /collections/all?view=mgx-search-index, 0 = no match
 * query may be a parseQuery() result or the raw text. Loaded twice on some pages (the overlay
 * and the collection bar both include it): the second run does nothing.
 */
(() => {
  if (window.mgxSearchCore) return;

  // "prefix:value" tags contribute their value (brand:tom-ford -> "tom ford", note:tonka-bean ->
  // "tonka bean"), except these prefixes.
  const SKIP_PREFIXES = ['gender'];
  // Plain tags that say nothing a shopper would type (gender has its own filters), folded.
  const SKIP_TAGS = new Set([
    'men', 'women', 'unisex', 'for men', 'for women', 'fuer maenner', 'fuer frauen', 'dfw active',
    'new', 'new arrival', 'bundle', 'bundle price show', 'giftbox ghost product', 'hide bundle',
    'usa test', 'bundle test', 'mystery box', 'hidden', 'onsale', '25 edp',
  ]);
  const SKIP_TAG_RE = /^test [a-z] \d+$/;
  // Names shoppers use for the same house or note. When one phrase is in a product's text, the
  // others are added too. Folded, whole phrases.
  const SYNONYMS = [
    ['jean paul gaultier', 'jpgaultier', 'jp gaultier', 'jpg', 'gaultier'],
    ['yves saint laurent', 'ysl', 'saint laurent'],
    ['maison francis kurkdjian', 'mfk', 'kurkdjian'],
    ['dolce gabbana', 'dolce and gabbana', 'dg', 'd g'],
    ['louis vuitton', 'lv'],
    ['thierry mugler', 'mugler'],
    ['paco rabanne', 'rabanne'],
    ['giorgio armani', 'emporio armani', 'armani'],
    ['hugo boss', 'boss'],
    ['christian dior', 'dior'],
    ['bvlgari', 'bulgari'],
    ['calvin klein', 'ck'],
    ['viktor rolf', 'viktor and rolf', 'viktor'],
    ['by kilian', 'kilian'],
    ['escentric molecules', 'molecules'],
    ['carolina herrera', 'herrera'],
    ['tom ford', 'tomford'],
    ['vanilla', 'vanille'],
  ];

  // German umlauts: to a German shopper "ä" and "ae" are the same letter, so the haystack and the
  // query are both folded to the "ae / oe / ue / ss" spelling right after lowercasing, before the
  // accents are stripped ("Kölner" and "Koelner" both become "koelner"). foldPlain keeps the plain
  // spelling ("ü" -> "u"); buildHay adds those words to the haystack as well, so a shopper who
  // drops the umlaut ("parfum", "kolner") still finds "Parfüm" and "Kölner".
  const UMLAUTS = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' };
  const foldText = (value, umlauts) => {
    let text = String(value == null ? '' : value).toLowerCase();
    if (umlauts) {
      // A decomposed "a" + U+0308 (pasted text, macOS input) becomes "ä" first.
      try {
        text = text.normalize('NFC');
      } catch (e) {}
      text = text.replace(/[äöüß]/g, (letter) => UMLAUTS[letter]);
    }
    try {
      text = text.normalize('NFD').replace(/[̀-ͯ]/g, '');
    } catch (e) {}
    return text
      .replace(/ß/g, 'ss')
      .replace(/æ/g, 'ae')
      .replace(/œ/g, 'oe')
      .replace(/ø/g, 'o')
      .replace(/['’`]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  };
  const fold = (value) => foldText(value, true);
  const foldPlain = (value) => foldText(value, false);

  const tagWords = (raw) =>
    String(raw || '')
      .split('|')
      .map((tag) => {
        const colon = tag.indexOf(':');
        if (colon > -1) {
          const prefix = fold(tag.slice(0, colon));
          if (SKIP_PREFIXES.includes(prefix)) return '';
          return tag.slice(colon + 1);
        }
        const folded = fold(tag);
        return SKIP_TAGS.has(folded) || SKIP_TAG_RE.test(folded) ? '' : tag;
      })
      .join(' ');

  // Every number in the title, without and with leading zeros: "034" -> 34, 034; "219M" -> 219.
  const numberWords = (folded) => {
    const words = [];
    (folded.match(/\d+/g) || []).forEach((digits) => {
      const bare = digits.replace(/^0+(?=\d)/, '');
      words.push(bare, bare.padStart(3, '0'));
    });
    return words;
  };

  // title: the product title; extra: more searchable text (inspiration, brand, type); tags: an
  // array or a "tag|tag" string.
  const buildHay = (title, extra, tags) => {
    const titleText = title == null ? '' : String(title);
    const tagText = Array.isArray(tags) ? tags.join('|') : tags;
    const foldedTitle = fold(titleText);
    const text = [titleText, extra == null ? '' : String(extra), tagWords(tagText)].join(' ');
    let hay = ` ${fold(text)} ${numberWords(foldedTitle).join(' ')} `;
    // The same words in their plain spelling ("parfum" next to "parfuem"), only where they differ.
    foldPlain(text)
      .split(' ')
      .forEach((word) => {
        if (word && !hay.includes(` ${word} `)) hay += `${word} `;
      });
    SYNONYMS.forEach((group) => {
      if (group.some((phrase) => hay.includes(` ${phrase} `))) hay += `${group.join(' ')} `;
    });
    return { hay, compact: hay.replace(/ /g, '') };
  };

  const parseQuery = (raw) => {
    const folded = fold(raw);
    const terms = folded ? folded.split(' ').map((term) => (/^\d+$/.test(term) ? term.replace(/^0+(?=\d)/, '') : term)) : [];
    return { terms, compact: folded.replace(/ /g, '') };
  };
  const toQuery = (query) => (query && Array.isArray(query.terms) ? query : parseQuery(query));

  // Numbers match a whole word ("21" is not "219m"); words up to 3 letters match the start of a
  // word, so "di" already finds "dior" while typing and "man" skips "gourmand"; longer terms match
  // anywhere.
  const termHit = (hay, term) => {
    if (/^\d+$/.test(term)) return hay.includes(` ${term} `);
    if (term.length <= 3) return hay.includes(` ${term}`);
    return hay.includes(term);
  };

  const matches = (entry, rawQuery) => {
    const query = toQuery(rawQuery);
    const { hay, compact } = entry;
    // Fallback for words typed together ("tomford", "no247"); from 4 characters, so "man" stays a
    // word start and doesn't hit "gourmand".
    return query.terms.every((term) => termHit(hay, term)) || (query.compact.length >= 4 && compact.includes(query.compact));
  };

  // Ranking for the overlay: exact scent number, then every term at a word start of the
  // inspiration or title, then of the brand, then any other match (notes, family, tags). Then
  // bestsellers up and sets down, unless the query asks for a set. A match never scores below 1,
  // so 0 always means "no match"; sort by score, then by title.
  const SET_WORDS = /set|bundle|flasch|paket/;
  const wordStarts = (text, terms) => {
    const padded = ` ${fold(text)}`;
    return terms.every((term) => padded.includes(` ${term}`));
  };
  const score = (item, rawQuery) => {
    if (!item) return 0;
    const query = toQuery(rawQuery);
    const { terms } = query;
    if (!terms.length) return 0;
    let points = 0;
    const number = String(item.number == null ? '' : item.number).replace(/^0+(?=\d)/, '');
    if (terms.length === 1 && /^\d+$/.test(terms[0]) && number && terms[0] === number) {
      points = 1000;
    } else {
      if (!item._hay) {
        item._hay = buildHay(item.title, [item.inspiration, item.brand, item.type].filter(Boolean).join(' '), item.tags);
      }
      if (!matches(item._hay, query)) return 0;
      if (wordStarts(`${item.inspiration || ''} ${item.title || ''}`, terms)) points = 500;
      else if (item.brand && wordStarts(item.brand, terms)) points = 300;
      else points = 100;
    }
    if (item.bestseller) points += 20;
    if (fold(item.type) === 'bundle' && !terms.some((term) => SET_WORDS.test(term))) points -= 150;
    return Math.max(points, 1);
  };

  window.mgxSearchCore = { fold, parseQuery, buildHay, matches, score };
  document.dispatchEvent(new CustomEvent('mgx:search-core:ready'));
})();
