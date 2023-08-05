let listenPort = 6256;
//listenPort = 6257;
const hostname = 'blender.pymnts.com'
const privateKeyPath = `/etc/letsencrypt/live/${hostname}/privkey.pem`;
const fullchainPath = `/etc/letsencrypt/live/${hostname}/fullchain.pem`;

require('dotenv').config();
const express = require('express');
const https = require('https');
const cors = require('cors');
const fs = require('fs');
const socketio = require('socket.io');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const cheerio = require('cheerio');
const mysql = require('mysql2');

const s3 = require('./utils/s3');
const urlUtils = require('./utils/url');
const wp = require('./utils/wordpress');
const ai = require('./utils/ai');
const convert = require('./utils/conversion');
const nlp = require('./utils/nlp');
const dom = require('./utils/dom');
const search = require('./utils/serpWow');

const app = express();
app.use(express.static('public'));
app.use(express.json({limit: '200mb'})); 
app.use(cors());

const pool = mysql.createPool({
  host: 'localhost',
  user: 'blender',
  database: 'blender',
  waitForConnections: true,
  connectionLimit: 2,
  password: process.env.MYSQL_PASSWORD
});

const query = async query => {
  return new Promise((resolve, reject) => {
    pool.query(query, (err, rows) => {
      if (err) {
        console.error(err);
        return resolve(false);
      }
      return resolve(rows);
    })
  })
}

const teso = async () => {
  let result = await query('SHOW DATABASES');

  console.log('result', result);
}

teso();

/*
 * REST API Functions
 */

const handleLogin = async (req, res) => {
  const {username, password} = req.body;

  if (!username || !password) return res.status(400).json('bad request');

  const result = await wp.getJWT('delta.pymnts.com', username, password);

  if (result === false)  return res.status(401).json('invalid credentials');
  
  let token = jwt.sign({result}, process.env.JWT_SECRET, {expiresIn: '3h'});

  res.status(200).json(token);
}
const sendSeeds = async () => {
  const q = `SELECT * FROM seeds ORDER BY id DESC LIMIT 200`;
  const r = await query(q);
  //console.log('r', r);
  if (r !== false) {
    io.emit('seeds', r);
  }
}
const processSeed = async (req, res) => {
  let { article, url, title, altTitle, body } = req.body;

  //console.log('body', body);

  if (body) article = body;

  const fileName = `seed--${uuidv4()}.html`;
  let link = await s3.uploadHTML(article, 'seeds', fileName);
  
  if (!link) return res.status(500).json('internal server error');

  const q = `INSERT INTO seeds (url, link, title, article) VALUES ('${url}', '${link}', ${mysql.escape(title ? title : altTitle)}, ${mysql.escape(article)})`;
  let result;

  try {
      result = await query(q);
  } catch (err) {
      console.error('processSeed error', err);
      return res.status(500).json("mysql error");
  }
  sendSeeds();
  res.status(200).json({fileName});
}


app.post('/seed', (req, res) => processSeed(req, res));

app.post('/login', (req, res) => handleLogin(req, res));

app.get('/', (req, res) => {
    res.send('Hello, World!');
});

/*
 * Socket Functions
 */



const getTopics = async (text, num = 5) => {
  const prompt = `'''Provide a list of of the  ${num === 1 ? 'most significant topic' : `${num} most significant topics`} contained in the following text. The returned format must be stringified JSON in the following format: {
    "topics": array of topics goes here,
    "numTopics": the number of topics goes here
  }
  
  Text:
  ${text}'''
  `
  //console.log('prompt', prompt);
  
  const keywords = await ai.getChatJSON(prompt);

  return keywords;
}

const getKeywords = async (text, num = 5) => {
  const prompt = `'''Provide a list of of the  ${num === 1 ? 'most significant keyword' : `${num} most significant keywords`} contained in the following text. Keywords include the names of all people, places, products, services, companies, and organizations mentioned in the text. The returned format must be stringified JSON in the following format: {
    "keywords": array of keywords goes here,
    "numKeywords": the number of keywords goes here
  }
  
  Text:
  ${text}'''
  `
  console.log('prompt', prompt);
  
  const keywords = await ai.getChatJSON(prompt);

  return keywords;
}

const createLink = async (sentence, url) => {
  sentence = sentence.trim();
  const result = await getKeywords(sentence, 10);
  
  let keyword;

  if (result !== false) {
    const { keywords } = result;
    let curSize = 0;
    keywords.forEach(entry => {
      if (entry.length > curSize) {
        curSize = entry.length;
        keyword = entry;
      }
    })
  } else {
    let loc = sentence.indexOf(' ');
    keyword = sentence.substring(0, loc);  
  }

  let loc = sentence.toLowerCase().indexOf(keyword.toLowerCase());

  let left, middle, right;

  if (loc === 0) {
    left = `<a href="${url}" target="_blank">${keyword}</a>`;
    middle = '';
    right = sentence.substring(keyword.length);
  } else {
    left = sentence.substring(0, loc);
    middle = `<a href="${url}" target="_blank">${keyword}</a>`;
    right = sentence.substring(loc + keyword.length);
  }


  return left + middle + right;

  

}

const addArticle = async (url, articles, index, topic, numParagraphs) => {
  const html = await urlUtils.getHTML(url);
  const article = await urlUtils.extractArticleFromHTML(html);
  const text = urlUtils.getTextFromHTML(article);

  const prompt = `'''Below is an Article. In ${numParagraphs === 1 ? 'one paragraph' : `${numParagraphs} paragraphs`}, summarize the information in the article regarding the following topic: ${topic}. If there is no information regarding the following topic, solely respond with the word "none": ${topic} 
  [Style Guide: Make sure the returned content is highly engaging and dynamic.]
  
  Article:
  ${text}'''
  `
  const result = await ai.getChatText(prompt);

  if (result === false) return false;
  
  console.log(`ARTICLES[${index}] ${topic}:`, result.substring(0, 128));
  articles[index] = {
    text: result,
    url,
    topic
  }
}

const getPymntsWriteups = async (content, topic, numParagraphs = 2, numWriteups = 3) => {
  console.log('getPymntsWriteups', topic);
  let results;

  topic += " site:pymnts.com";
  articles = [];
  promises = [];

  try {
    results = await search.google('news', topic, 'last_month', numWriteups);
    for (let i = 0; i < results.length; ++i) {
      let url = results[i].link;
      promises.push(addArticle(url, content, i, topic, numParagraphs));
    }
    await Promise.all(promises);
    console.log('getPymntsWriteups', topic, articles);
    return articles;
  } catch (err) {
    console.error('getPymntsWriteups ERROR:', err);
  }

  return results;
}

const getPymntsSummary = async (content, topic, numParagraphs, numWriteups) => {
  console.log('getPymntsSummary', topic)
  const writeups = await getPymntsWriteups(content, topic, numParagraphs, numWriteups);
  
}

const getPymntsSummariesForTopics = async (topics, numParagraphs = 2, numWriteupsPerTopic = 3) => {
  const promises = [];
  const summaries = [];

  //const length = topics.length > 2 ? 2 : topics.length;
  const length = topics.length;

  for (let i = 0; i < length; ++i) {
    summaries[i] = {topic: topics[i], content: []}
    promises.push(getPymntsSummary(summaries[i].content, topics[i], numParagraphs, numWriteupsPerTopic));
  }
  
  await Promise.all(promises);
  console.log('SUMMARIES', JSON.stringify(summaries, null, 4));  
  return summaries;
}

const extractUrlText = async (mix, index) => {
  const url = mix.content[index].url;
  console.log('extractUrlText url', url);

  const urlType = urlUtils.urlType(url);  // later add function here to get the type

  let text, fileName;

  switch (urlType) {
    case 'php':
    case 'aspx':
    case 'html':
    case 'htm':
      const html = await urlUtils.getHTML(url);
      console.log(`html length ${html ? html.length : 0}: ${url}`)
      const article = await urlUtils.extractArticleFromHTML(html);
      console.log(`article length ${article ? article.length : 0}: ${url}`);
      text = urlUtils.getTextFromHTML(article);
      /*
       * TODO: If article === false email Michael with URL
       */

      console.log('article length', article.length, url);
      break;
    case 'docx':
      fileName = `/home/tmp/${uuidv4()}.docx`;
      try {
        await urlUtils.download(url, fileName);
        let html = await convert.convertDocxToHTML(fileName);
        console.log('Got initial html');
        html = convert.removeImagesAndTablesFromHTML(html);
        text = urlUtils.getTextFromHTML(html);
        
      } catch (err) {
        console.error(err);
        text = '';
      }
      break;
    case 'pdf':
        fileName = `/home/tmp/${uuidv4()}.pdf`;
        try {
          await urlUtils.download(url, fileName);
          text = await convert.convertPdfToText(fileName);
          console.log('pdf text', text);
          
        } catch (err) {
          console.error(err);
          text = '';
        }
        break;
    default:
      console.error('ERROR: unknown urlType', urlType);
      text = '';
    }

    mix.content[index].text = text.replaceAll('“', '"').replaceAll('”', '"');
      
}

const extractText = async mix => {
  //console.log('mix', JSON.stringify(mix, null, 4));
  const promises = [];

  for (let i = 0; i < mix.content.length; ++i) {
    switch (mix.content[i].type) {
      case 'url':
        promises.push(extractUrlText(mix, i));
        break;
      default:
        console.error('extractText unknown type', mix.content[i].type);
        //console.log(JSON.stringify(mix.content[i], null, 4))
        mix.content[i].text = '';
    }
  }

  await Promise.all(promises);
  return;
}



const getInfo = async (mix, i, j, numChunks) => {
  let numFacts;

  if (numChunks > 15) numFacts = 1;
  else if (numChunks > 5) numFacts = 2;
  else if (numChunks <= 3) numFacts = 4;

  let info = mix.content[i].chunks[j];

  if (!info) {
    mix.content[i].info[j] = {
      info: '',
      quotes: [],
      facts: []
    }

    return;
  }

  if (mix.topic) {
    prompt = `"""Below is some Text. I need you return all the facts from the text that are relevant to the following topic: ${mix.topic}. Solely return facts that are relevant to that topic.
    Also return a list of third-party quotes that are related to the following topic: ${mix.topic}.
    Also return a list of the ${numFacts} most pertinent facts that are related to the following topic: ${mix.topic}.
    The return format must be stringified JSON in the following format: {
      info: array of all the facts that related to the topic '${mix.topic}' goes here,
      quotes: array of quotes in the following format {
        speaker: the identity of the speaker goes here,
        affiliation: the organization that the speaker is affiliated with goes here,
        quote: the speaker's quote goes here
      },
      facts: array of the ${numFacts} pertinent facts goes here in the following format : {fact: the fact goes here, keywords: array of prominent keywords in the fact goes here}
    }
    
    Text:
    ${info}"""
    `
    mix.content[i].info[j] = await ai.getChatJSON(prompt);
    mix.content[i].info[j].info = mix.content[i].info[j] !== false ? mix.content[i].info[j].info.join(" ") : '';
  } else {

    prompt = `"""Below is some Text. I need you to extract all third-party quotes including the speaker (if any).
    I also need you to return a list of the ten most pertinent facts from the Text.
    The return format must be stringified JSON in the following format: {
      quotes: {
        speaker: the identity of the speaker goes here,
        affiliation: the organization that the speaker is affiliated with goes here,
        quote: the speaker's quote goes here
      },
      facts: array of the three pertinent facts goes here
    }
    
    Text:
    ${info}"""
    `
    mix.content[i].info[j] = await ai.getChatJSON(prompt);

    if (mix.content[i].info[j] !== false) {
      mix.content[i].info[j].info = info;
    } else {
      mix.content[i].info[j] = {info: info, quotes: [], facts: []};
    }
  }

  console.log(`mix.content[${i}].info[${j}]`);
}

const extractSummaries = async (mix) => {
  //console.log('mix.topic', mix.topic);
  //console.log('mix', JSON.stringify(mix, null, 4));
  
  const promises = [];
  //console.log('mix.content.length', mix.content.length);
  for (let i = 0; i < mix.content.length; ++i) {
    mix.content[i].summaries = [];
    for (let j = 0; j < mix.content[i].chunks.length; ++j) {
      promises.push(getPymntsSummary(mix, i, j))
    }
  }

  await Promise.all(promises);
}

const writeAbout = async (articlePart, topic, outputType) => {
  let prompt = `"""Below are a set of Facts. In ${Math.ceil(articlePart.tokens/2) < 800 ? Math.ceil(articlePart.tokens/2) : 800} words, write a highly engaging, dynamic ${outputType} using as many facts as possible.
  
  ${articlePart.facts}"""
  `

  prompt = `"""Below are a set of Facts and Quotes. In ${Math.ceil(articlePart.tokens/2) < 800 ? Math.ceil(articlePart.tokens/2) : 800} words, write a highly engaging, dynamic ${outputType} using as many facts and quotes as possible.
  
  ${articlePart.facts}
  
  ${articlePart.quotes}"""
  `




//  articlePart.part = await ai.getChatText(prompt);
  articlePart.part = await ai.getDivinciResponse(prompt, 'text', 1, true);
  articlePart.partWords = articlePart.part.split(' ').length;
  articlePart.partTokens = nlp.numGpt3Tokens(articlePart.part);

}

const reduceArticlePart = async (articlePart, keepPercent) => {
  prompt = `"""Below is an Article. Reduce this article to ${Math.floor(articlePart.partWords * keepPercent)} words, keeping the article highly dynamic and engaging.
  
  Article:
  ${articlePart.part}"""
  `



  articlePart.reduced = await ai.getChatText(prompt);
  articlePart.reducedWords = articlePart.reduced.split(' ').length;
  articlePart.reducedTokens = nlp.numGpt3Tokens(articlePart.reduced);
}

const mergeArticleParts = async (articleParts, topic) => {
  console.log('mergeArticleParts topic', topic);
  let articles = '';
  for (let i = 0; i < articleParts.length; ++i) articles += `Article ${i+1}:\n${articleParts[i].reduced}\n\n`;
  if (!topic) {
    prompt = `"""Below are ${articleParts.length} Articles. Using 800 words, rewrite these articles into a one highly engaging and dynamic 1100-word article.
  
  ${articles}"""
  `
  } else {
    prompt = `"""Below are ${articleParts.length} Articles. Use the information in these articles to write a highly dynamic and engaging 1100-word article about the following topic: ${topic}.

    [Content Guide: Make sure the returned content solely includes information related to the following topic: ${topic}. Make sure to preserve all quotes in the returned content. Make sure the returned content is solely based on the provided articles. Make sure the return content length is approximately 1100 words.]
  
  ${articles}"""
  `
prompt = `"""Below are ${articleParts.length} Articles which may contain quotes. Use the information and quotes in these articles to write a highly dynamic and engaging 1100-word article about the following topic: ${topic}. Be sure that the returned content utilizes every quote verbatim.

${articles}"""
`
prompt = `"""Below are ${articleParts.length} Articles which may contain quotes. Using 1100 words, combine the information and quotes in these articles to write a highly dynamic and engaging article about the following topic: ${topic}. Be sure that the returned content utilizes every quote verbatim.

${articles}"""
`
  }

  return await ai.getDivinciResponse(prompt, 'text', 1, true);
  return await ai.getChatText(prompt);
}

const getQuote = info => {
  const { speaker, affiliation, quote } = info;

  if (speaker && affiliation) return `${speaker}, ${affiliation}, states: "${quote}"`;
  if (speaker) return `${speaker} states: "${quote}"`;
  if (affiliation) return `${affiliation} states: "${quote}"`;
  return '';
}

const getQuote2 = info => {
  const { speaker, affiliation, quote } = info;

  if (speaker && affiliation) return `${speaker}, ${affiliation}, states: "${quote}"`;
  if (speaker) return `${speaker} states: "${quote}"`;
  if (affiliation) return `${affiliation} states: "${quote}"`;
  return '';
}

const addSubheadings = async (mergedArticle, html, info) => {
  
  const quotes = info.map(entry => entry.quotes);
  const quoteList = [];
  for (let i = 0; i < quotes.length; ++i) {
    for (let j = 0; j < quotes[i].length; ++j) {
      let quote = getQuote(quotes[i][j]);
      console.log('addSubheadings quote: ', quote);
      if (quote) quoteList.push(quote);
    }
  }
  console.log('addSubheadings quotes', quotes);
  
  let use = [];
  if (html.headings) use.push('headings, subheadings');
  if (html.tables) use.push('tables');
  if (html.bullets) use.push('bullets');
  if (html.bold) use.push('bold');

  let useStr = use.length > 0 ? use.join(', ') + " and paragraphs " : " paragraphs ";

  let prompt = `"""Below is some Content. Using ${mergedArticle.numWords + 100} words, rewrite the content using HTML. Use ${useStr} to organize the information.
  
  Content:
  ${mergedArticle.content}"""
  `

//   prompt = `"""Below is some Content and Quotes. Using ${mergedArticle.numWords + 200} words, expand the content by incorporating ${Math.ceil(quoteList/3)} relevant quotes.
//   [Format Guide: The return format should be HTML using ${useStr} to organize the information.]
//   Content:
//   ${mergedArticle.content}
//   Quotes:
//   ${quoteList.join("\n")}"""
// `

  console.log('PROMPT', prompt);

  return await ai.getDivinciResponse(prompt);
}

const getFactLink = (fact, keywords, url) => {
  let index = -1;
  let len = 0;

  for (let i = 0; i < keywords.length; ++i) {
    if (keywords[i].length > len) {
      index = i;
      len = keywords[i].length;
    }
  }

  if (index === -1) return false;

  let loc = fact.toLowerCase().indexOf(keywords[index].toLowerCase());

  if (loc === -1) return false;

  let left = fact.substring(0, loc);
  let middle = fact.substring(loc, loc + keywords[index].length);
  let right = fact.substring(loc + keywords[index].length);

  let link = `${left}<a href="${url}" target="_blank">${middle}</a>${right}`;

  return link;
  
}

const getFactsTokens = part => {
  const factList = [];
  const quoteList = [];
  const factLinks = [];

  for (let i = 0; i < part.keyFacts.length; ++i) {
    factList.push(part.keyFacts[i].fact);
    const factLink = getFactLink(part.keyFacts[i].fact, part.keyFacts[i].keywords, `http://c.co?n=${part.num}`);
    if (factLink !== false) factLinks.push(factLink);
  }

  for (let i = 0; i < part.quotes.length; ++i) {
    const quote = getQuote(part.quotes[i]);
    //console.log('QUOTE', quote);
    quoteList.push(quote);
    //const factLink = getFactLink(quote, part.keyFacts[i].keywords, `http://c.co?n=${part.num}`);
    //if (factLink !== false) factLinks.push(factLink);
  }

  //console.log('FACTLIST', factList);

  part.factList = factList.join("\n");
  part.quoteList = quoteList.join("\n");
  part.factsTokens = nlp.numGpt3Tokens(part.factList);
  part.quotesTokens = nlp.numGpt3Tokens(part.quoteList);
  part.factLinks = factLinks;

}

const writeArticlePart = async (part, topic, outputType, article, index, location) => {
  let prompt;
  let format;

  if (!part || part.length < 10) article[index] = '';
  
  switch (location) {
    case 'beginning':
      format = `The return format must be HTML. Use headings, subheadings, bullet points, paragraphs, and bold to organize the information.`
      break;
    case 'middle':
      format = `The return format must be HTML. Use headings, subheadings, bullet points, paragraphs, and bold to organize the information.`
      break;
    case 'end':
      format = `The return format must be HTML. Use headings, subheadings, bullet points, paragraphs, and bold to organize the information.`
      break;
    default:
      format = `The return format must be HMTL. Use headings, subheadings, bullet points, paragraphs, and bold to organize the information.`
  }

  switch (location) {
    case 'beginning':
      format = `The return format must be HTML. Use subheadings, paragraphs, bullet points, tables, and bold to organize the information. Use subheading for every 2 or 3 paragraphs.`
      break;
    case 'middle':
      format = `The return format must be HTML. Use subheadings, paragraphs, bullet points, tables, and bold to organize the information. Use a subheading for every 2 or 3 paragraphs.`
      break;
    case 'end':
      format = `The return format must be HTML. Use subheadings, paragraphs, bullet points, tables, and bold to organize the information. Use a subheading for every 2 or 3 paragraphs.`
      break;
    default:
      format = `The return format must be HMTL. Use subheadings, paragraphs, bullet points, tables, and bold to organize the information. Use a subheading for every 2 or 3 paragraphs.`
  }


  if (topic) {
//     prompt = `"""[Return just the main response. Take out the pre-text and the post-text]
//     Below are one or more Sources along with the Source numbers (#{sourceId}). These sources have Info and KeyFacts. Write a highly engaging, dynamic, long-form ${outputType} on the following topic: ${topic}; using as much Info and KeyFacts as possible that is related to that topic.
// ${part}"""
// `
prompt = `"""
Below are a set of Facts. Using 800 words, write a highly engaging, dynamic ${outputType} regarding the following topic: ${topic}.
${format}
${part}"""
`
  } else {
//     prompt = `"""[Return just the main response. Take out the pre-text and the post-text]
//     Below are one or more Sources along with the Source numbers (#{sourceId}). These sources have Info and KeyFacts. Write a highly engaging, dynamic, long-form ${outputType}using as much Info and KeyFacts as possible.
// ${part}"""
// `

    prompt = `"""
Below are a set of Facts. Using 800 words, write a highly engaging, dynamic ${outputType} using as many of the facts as possible.
${format}
${part}"""
`
  }

  article[index] = await ai.getChatText(prompt);
}

const extractSubheadingSections = html => {
  const bodyBeginning = html.indexOf('<body>');
  const bodyEnding = html.indexOf('</body>');

  const body = (bodyBeginning < 0 || bodyEnding < 0) ? html : html.substring(bodyBeginning + 6, bodyEnding);

  const h2Locs = [];
  let h2loc = -1;
  while (true) {
    h2loc = body.indexOf('<h2>', h2loc+1);
    if (h2loc === -1) break;
    h2Locs.push(h2loc);
  }

  //console.log('body', body);
  //console.log('h2Locs', h2Locs);

  const h2s = [];

  if (h2Locs[0] > 0) h2s.push(body.substring(0, h2Locs[0]));
  for (let i = 0; i < h2Locs.length - 1; ++i) {
    h2s.push(body.substring(h2Locs[i], h2Locs[i+1]))
  }
  h2s.push(body.substring(h2Locs[h2Locs.length - 1]));

  //console.log('H2S', h2s);

  for (let i = 0; i < h2s.length; ++i) {
    console.log(`h2 #${i}: `, h2s[i]);
  }

  return h2s;
  
}

const expandSubsection = async (mergedArticle, subheadingIndex, factLinks) => {
  const prompt = `"""I need to add relevant FactLinks to the provided Text. Expand the provided Text by incorporating two FactLinks that are relevant to the Text. If none on the FactLinks are relevant to the Text then return the entire Text as is.
  
  Text:
  ${mergedArticle.subheadings[subheadingIndex]}

  FactLink: ${factLinks.join("\nFactLink: ")}"""
  `

  console.log(prompt);

  mergedArticle.expandedSubheadings[subheadingIndex] = await ai.getChatText(prompt);
}

const textIsNotRelevant = text => {
  let testText = text.toLowerCase();
  let test = testText.indexOf('none');
  let filter = false;


  if (test > -1 && test < 10) filter = true;
  else if (test > text.length - 10) filter = true;
  else if (testText.indexOf('no information') > -1) filter = true;
  else if (testText.indexOf('does not provide information') > -1) filter = true;
  else if (testText.indexOf('none of the information') > -1) filter = true;
  else if (testText.indexOf('does not provide any information') > -1) filter = true;

  if (filter) console.log('FILTERED', text);
  return filter;
}

const filterPymntsText = text => {
  
  text = text.replaceAll('The article', 'PYMNTS').replaceAll('in the article', 'according to PYMNTS').replaceAll('the article', 'PYMNTS').replaceAll('The document', 'PYMNTS');

  return text;
  
}

const linkifyParagraph = async (paragraph, url) => {
  let sentences = nlp.getSentences(paragraph.trim());
  console.log('linkifyParagraph sentences', sentences);

  let num = -1;
  for (let i = 0; i < sentences.length; ++i) {
    if (sentences[i].length > 15) {
      num = i;
      break;
    }
  }
  console.log('linkifyParagraph num', num);

  if (num === -1) {
    return paragraph;
  }

  sentences[num] = await createLink(sentences[num], url);

  return sentences.join(' ');
}

const attachPymnts = async (article) => {
  const origArticle = article;

 try {
  let result = await getTopics(article);

  if (result !== false) {
    const { topics } = result;
    console.log('TOPICS', topics);
    result = await getPymntsSummariesForTopics(topics);

    if (result !== false) {
      let section = '';
      for (let i = 0; i < result.length; ++i) {
        if (typeof result[i].content === 'undefined') continue;

        const { topic, content } = result[i];
        console.log(topic, content);
        let num = 0;
        section = `<h3>More on ${topic.replace(/(^\w{1})|(\s+\w{1})/g, letter => letter.toUpperCase())}</h3>`
        console.log('SECTION H2', section);
        for (let j = 0; j < content.length; ++j) {
          let { text, url } = content[j];
          
          if (textIsNotRelevant(text)) continue;
          ++num;

          text = filterPymntsText(text);
          let paragraphs = text.split("\n");
          for (let k = 0; k < paragraphs.length; ++k) {
            if (k === 0) {
              paragraphs[k] = await linkifyParagraph(paragraphs[k], url);
            }
            section += `<p>${paragraphs[k]}</p>`;
          }
        }
        console.log('SECTION', num, section);
        if (num) article += section;
      }
      
    }
  }

  return article;
 } catch (err) {
  console.error ('attachPymnts', err);
  return origArticle;
 }
}

const getLinksUsed = mix => {
  const linksUsed = [];

  for (let i = 0; i < mix.content.length; ++i) {
    const link = mix.content[i].url;
    const title = mix.content[i].title;
    try {
      let test = new URL(link);
      linksUsed.push({title, link});
    } catch (err) {
      console.error('getLinksUsed ERROR', err)
    }
  }

  return linksUsed;
}

const attachLinksUsed = (article, linksUsed) => {
  if (!linksUsed.length) return article;

  let section = `<h2>Third-Party Sources</h2><p>In addition to PYMNTS own sources and reporting, the following third-party sources were consulted in the creation of this article:<p><ul>`;
  for (let i = 0; i < linksUsed.length; ++i) section += `<li><a href="${linksUsed[i].link}" target="_blank">${linksUsed[i].title}</li>`
  section += '</ul>';

  article += section;

  return article;
}

const sendTagsAndTitles = async (article, socket) => {
  const prompt = `"""Give 10 interesting, eye-catching titles for the provided News Article below.
  Also generate a list of tags that include the important words and phrases in the response. 
  The list of tags must also include the names of all people, products, services, places, companies, and organizations mentioned in the response.
  Also generate a conclusion for the news article.
  The return format must be stringified JSON in the following format: {
      "titles": array of titles goes here
      "tags": array of tags go here
      "conclusion": conclusion goes here
  }
  News Article:
  ${article}\n"""\n`;

  let tat = await ai.getChatJSON(prompt);

  if (tat === false) tag = {
    titles: [],
    tags: [],
    conclusion: ''
  }
  console.log('TAGSANDTITLES', tat);
  
  socket.emit('tagsAndTitles', tat);
}

const extractQuote = (sentence, loc) => {
  const loc2 = sentence.indexOf('"', loc + 1);
  if (loc2 === -1) return false;
  let quote = sentence.substring(loc+1, loc2);

  if (quote.endsWith(',')) quote = quote.substring(0, quote.length -1);
  if (quote.endsWith('.')) quote = quote.substring(0, quote.length -1);
  
  return quote;
}

const findQuoteInChunks = (quote, chunks) => {
  for (let i = 0; i < chunks.length; ++i) {
    if (chunks[i].info.indexOf(quote) !== -1) return chunks[i];
    for (let j = 0; j < chunks[i].keyfacts.length; ++j) if (chunks[i].keyfacts[j].fact.indexOf(quote) !== -1) return chunks[i];
    const strippedQuote = quote.substring(1, quote.length-1);
    console.log('strippedQuote', strippedQuote);
    for (let j = 0; j < chunks[i].quotes.length; ++j) if (chunks[i].quotes[j].quote.indexOf(quote) !== -1) return chunks[i];
  }

  return false;
}

const linkifiedSentence = (sentence, quote, url, loc1, loc2) => {
  const left = loc1 > 0 ? sentence.substring(0, loc1) : '';
  const right = loc2 < sentence.length ? sentence.substring(loc2) : '';

  const stripped = quote.substring(1, quote.length - 1);
  const words = stripped.split(' ');
  let blue = '';
  let black = '';
  for (let i = 0; i < words.length; ++i) {
    if (i < 3) blue += words[i] + ' ';
    else black += words[i] + ' ';
  }
  black = black.trimEnd();
  if (!black) blue = trimEnd();
  
  return `${left}"<a href="${url}" target="_blank">${blue}</a>${black}"${right}`;
}

const linkifyQuote = (sentence, content) => {
  console.log('LINKIFY', sentence);
  let loc1 = sentence.indexOf('"');
  const quote = extractQuote(sentence, loc1);
  console.log('QUOTE', quote);   
  if (quote === false) return sentence;

  for (let i = 0; i < content.length; ++i) {
    let { url, text } = content[i];
    text = text.toLowerCase();
    loc2 = text.indexOf(quote.toLowerCase());
    if (loc2 !== -1) {
      console.log('URL', url);
      return linkifiedSentence(sentence, quote, url, loc1, loc2)
    }
  }
  
  return sentence.replaceAll('"', '');
}

const linkifyQuotesOrig = (article, content) => {
  //console.log('ARTICLE', article);
  //console.log('CONTENT', JSON.stringify(content, null, 4));
  const sentences = nlp.getSentences(article);
  for (let i = 0; i < sentences.length; ++i) {
    const sentence = sentences[i];
    const test = sentence.indexOf('"');
    if (test === -1) {
      //console.log(`NO : ${sentence}`)
      continue;
    } else {
      //console.log(`YES: ${sentence}`);
      sentences[i] = linkifyQuote(sentence, content);
    }
    continue
    
  }

  console.log('SENTENCES', sentences);
  
  return sentences.join(' ');
}

const linkifyQuotes = (article, content) => {

}


const processMix = async (mix, socket) => {

  const linksUsed = getLinksUsed(mix);

  let outputType;
  switch (mix.output.type) {
    case 'news':
      outputType = 'news article';
      break;
    case 'blog':
      outputType = 'blog post';
      break;
    case 'summary':
      outputType = 'summary';
      break;
    case 'outline':
      outputType = 'outline';
      break;
    case 'marketing':
      outputType = 'marketing collateral';
      break;
  }
  
  socket.emit('msg', {status: 'success', msg: 'Retrieving contents'});

  /*
   * get text
   */
  await extractText(mix);

  socket.emit('text', mix.content);
  socket.emit('msg', {status: 'success', msg: ''});
  socket.emit('progress', {current: 1, max: 10});

  let totalTextLength = 0;
  for (let i = 0; i < mix.content.length; ++i) totalTextLength += mix.content[i].text.length > 100 ? mix.content[i].text.length : 0;

  if (!totalTextLength) return socket.emit('msg', {status: 'error', msg: 'Failed to get text'});

  /*
   * split text into chunks
   */
  for (let i = 0; i < mix.content.length; ++i) {
    if (!mix.content[i].text) mix.content[i].chunks = [];
    else mix.content[i].chunks = nlp.getTokenChunks(mix.content[i].text, 8000);
  }

  setTimeout(()=>{
    socket.emit('msg', {status: 'success', msg: ''})
    socket.emit('chunks', mix.content);
    socket.emit('progress', {current: 2, max: 10});
  }, 5000);

  /*
   * Extract information from chunks
   */

  let promises = [];
  for (let i = 0; i < mix.content.length; ++i) {
    mix.content[i].info = [];
    for (let j = 0; j < mix.content[i].chunks.length; ++j) {
      promises.push(getInfo(mix, i, j, mix.content[i].chunks.length))
    }
  }

  console.log('awaiting info promises', promises.length);
  await Promise.all(promises);
  socket.emit('progress', {current: 3, max: 10});

  socket.emit('info', mix.content);

  const articleChunks = [];

  let num = 0;

  const quoteList = [];

  for (let i = 0; i < mix.content.length; ++i) {
    for (let j = 0; j < mix.content[i].info.length; ++j) {
      if (mix.content[i].info[j].info) {
        articleChunks.push({
          num: num++,
          id: mix.content[i].id,
          source: mix.content[i].source,
          title: mix.content[i].title,
          type: mix.content[i].type,
          subType: typeof mix.content[i].subType !== 'undefined' ? mix.content[i].subType : '',
          url: mix.content[i].url,
          info: mix.content[i].info[j].info,
          keyFacts: mix.content[i].info[j].facts,
          quotes: mix.content[i].info[j].quotes,
          infoTokens: nlp.numGpt3Tokens(mix.content[i].info[j].info),
        })

        quoteList.push({
          url: mix.content[i].url,
          quotes: mix.content[i].info[j].quotes
        })
      }
    }
  }

  /*
   * get factList, factsTokens, factLinks, and quoteLinks
   */

  for (let i = 0; i < articleChunks.length; ++i) getFactsTokens(articleChunks[i]);
  socket.emit('progress', {current: 4, max: 10});


  /*
   * Sort the article chunks by total tokens needed ascending
   */

  articleChunks.sort((a, b) => (a.infoTokens + a.factsTokens) - (b.infoTokens + b.factsTokens));
  //console.log('ARTICLE CHUNKS', JSON.stringify(articleChunks, null, 4));

  const factLinks = [];

  for (let i = 0; i < articleChunks.length; ++i) {
    for (let j = 0; j < articleChunks[i].factLinks.length; ++j)
      factLinks.push(articleChunks[i].factLinks[j]);
  }
  
  //console.log('FACT LINKS', factLinks);

  /*
   * Combine article chunks into article parts based on token size
   */

  const maxPartTokens = 1750 * 4;
  const articleParts = [];
  let curFacts = "Facts:\n";
  let curQuotes = "Quotes:\n"
  let curTokens = 0;
  let articleTokens = 0;
  
  for (let i = 0; i < articleChunks.length; ++i) {
    let totalTokens = articleChunks[i].infoTokens + articleChunks[i].factsTokens + articleChunks[i].quotesTokens;
    articleTokens += totalTokens;
    let test = curTokens + totalTokens;
    if (test <= maxPartTokens) {
      curFacts += `${articleChunks[i].info.trim()}\n${articleChunks[i].factList}`;
      curQuotes += articleChunks[i].quoteList ? articleChunks[i].quoteList + "\n" : '';
      curTokens += totalTokens;
    } else {
      articleParts.push({facts: curFacts, tokens: curTokens, quotes: curQuotes});
      curFacts = `Facts:\n${articleChunks[i].info.trim()}\n${articleChunks[i].factList}`;
      curQuotes = articleChunks[i].quoteList ? "Quotes:\n" +  articleChunks[i].quoteList + "\n" : "Quotes:\n";
      curTokens = totalTokens;
    }
  }

  if (curFacts) articleParts.push({facts: curFacts, tokens: curTokens, quotes: curQuotes});

  console.log("QUOTE LIST", JSON.srintify(quoteList, null, 4));

  const mergedArticle = { content: ''}; 

  promises = [];
  for (let i = 0; i < articleParts.length; ++i) {
    promises.push(writeAbout(articleParts[i], mix.topic, outputType))
  }

  console.log('await articleParts promises', promises.length);

  await Promise.all(promises);
  socket.emit('progress', {current: 5, max: 10});
  //console.log('ARTICLE PARTS', articleParts);

  let totalWords = 0;
  let totalTokens = 0;

  for (let i = 0; i < articleParts.length; ++i) {
    totalWords += articleParts[i].partWords;
    totalTokens += articleParts[i].partTokens;
  }

  //console.log("TOTAL TOKENS", totalTokens)

  if (totalTokens > maxPartTokens) {
    
    let count = 0;
    let keepPercent = (maxPartTokens/totalTokens);
   while (totalTokens > maxPartTokens && count <= 3) {
    keepPercent -= .1;
    //console.log('keepPercent', keepPercent);

    promises = [];
    for (let i = 0; i < articleParts.length; ++i) {
      promises.push(reduceArticlePart(articleParts[i], keepPercent));
    }

    //console.log('awaiting reduce promises', promises.length);
    await Promise.all(promises);

    socket.emit('progress', {current: 6, max: 10});
    totalTokens = 0;
    for (let i = 0; i < articleParts.length; ++i) {
      totalTokens += articleParts[i].reducedTokens;
    }

    //console.log("TOTAL TOKENS", totalTokens);
    ++count;
   }

   /*
    * At this point .reduced has an acceptable totalToken count
    * It's time to merge the parts into a single article
    */

   console.log('awaiting merge', articleParts);

   mergedArticle.content = await mergeArticleParts(articleParts, mix.topic);
   socket.emit('progress', {current: 7, max: 10});

  } else if (articleParts.length > 1) {
    for (let i = 0; i < articleParts.length; ++i) {
      articleParts[i].reduced = articleParts[i].part;
      articleParts[i].reducedWords = articleParts[i].reduced.split(' ').length;
      articleParts[i].reducedTokens = nlp.numGpt3Tokens(articleParts[i].reduced);
    } 
    mergedArticle.content = await mergeArticleParts(articleParts, mix.topic);
    socket.emit('progress', {current: 7, max: 10});
  } else if (articleParts.length > 0) {
    articleParts[0].reduced = articleParts[0].part;
    articleParts[0].reducedWords = articleParts[0].reduced.split(' ').length;
    articleParts[0].reducedTokens = nlp.numGpt3Tokens(articleParts[0].reduced);
    mergedArticle.content = articleParts[0].part;
    socket.emit('progress', {current: 7, max: 10});
  } else {
    return socket.emit('msg', {status: 'error', msg: 'unabled to produced article'});
  }
    
  mergedArticle.numWords = mergedArticle.content.split(" ").length;
  mergedArticle.numTokens = nlp.numGpt3Tokens(mergedArticle.content);
  
  // if (mergedArticle.numWords > 800) {
  //   let prompt = `"""Reduce the following Content to 800 words.
    
  //   Content:
  //   ${mergedArticle.content}"""
  //   `

  //   console.log(prompt);
  //   mergedArticle.content = await ai.getDivinciResponse(prompt);
  // }

  mergedArticle.numWords = mergedArticle.content.split(" ").length;
  mergedArticle.numTokens = nlp.numGpt3Tokens(mergedArticle.content);
  
  console.log('awaiting adding subheadings: numWords numTokens', mergedArticle.numWords, mergedArticle.numTokens);

  if (mix.html.headings) mergedArticle.withSubheadings = await addSubheadings(mergedArticle, mix.html, articleChunks);
  else {
    let paragraphs = mergedArticle.content.split("\n");
    for (let i = 0; i < paragraphs.length; ++i) paragraphs[i] = `<p>${paragraphs[i]}</p>\n`;
    mergedArticle.withSubheadings = paragraphs.join('');
  }

  //mergedArticle.withSubheadings = linkifyQuotes(mergedArticle.withSubheadings, mix.content);

  socket.emit('progress', {current: 8, max: 10});

  //console.log('MERGED ARTICLE', mergedArticle);
  sendTagsAndTitles(mergedArticle.withSubheadings, socket);

  let curArticle = mix.output.pymntsConnector ? await attachPymnts(mergedArticle.withSubheadings) : mergedArticle.withSubheadings;
  socket.emit('progress', {current: 9, max: 10});

  curArticle = attachLinksUsed(curArticle, linksUsed);

  socket.emit('rawArticle', {rawArticle: curArticle});

  const q = `INSERT INTO wordpress_articles (id, article, settings) VALUES ("${uuidv4()}", ${mysql.escape(curArticle)}, ${mysql.escape(JSON.stringify(mix))})`;
  await query(q);

  socket.emit('progress', {current: 10, max: 10});


  return;

}


const getInfoLinks = async (mix, i, j, numFacts = 20) => {
  let info = mix.content[i].chunks[j];

  if (!info) {
    mix.content[i].info[j] = {
      info: '',
      quotes: [],
      facts: []
    }

    return;
  }

  if (mix.topic) {
    prompt = `"""Below is some Text. I need you return ${numFacts} facts from the text that are relevant to the following topic: ${mix.topic}. Solely return facts that are relevant to that topic.
    I also need you to return a list of all third-party quotes that are relevant to the following topic: ${mix.topic}.
    The return format must be stringified JSON in the following format: {
      facts: array of ${numFacts} facts that related to the topic '${mix.topic}' goes here,
      quotes: array of third-party quotes in the following format {
        speaker: the identity of the speaker goes here,
        affiliation: the organization that the speaker is affiliated with goes here,
        quote: the speaker's quote goes here
      }
    }
    
    Text:
    ${info}"""
    `
    mix.content[i].info[j] = await ai.getChatJSON(prompt);
  } else {

    prompt = `"""Below is some Text. I need you to extract all third-party quotes including the speaker (if any).
    I also need you to return a list of all the facts from the Text.
    The return format must be stringified JSON in the following format: {
      quotes: {
        speaker: the identity of the speaker goes here,
        affiliation: the organization that the speaker is affiliated with goes here,
        quote: the speaker's quote goes here
      },
      facts: array of facts goes here
    }
    
    Text:
    ${info}"""
    `
    mix.content[i].info[j] = await ai.getChatJSON(prompt);

    if (mix.content[i].info[j] !== false) {
      mix.content[i].info[j].info = info;
    } else {
      mix.content[i].info[j] = {info: info, quotes: [], facts: []};
    }
  }

  console.log(`mix.content[${i}].info[${j}]`);
}


const getNumAccordingToTokens = (accordingToList) => {
  let numTokens = 0;
  accordingToList.forEach(entry => {
    numTokens += nlp.numGpt3Tokens(entry.fact);
  })

  return numTokens;
}

const randomlyRemoveFact = accordingToList => {
  let num = Math.floor(Math.random() * accordingToList.length);
  if (num >= accordingToList.length) num = accordingToList.length - 1;

  console.log('remove', num);
  accordingToList.splice(num, 1); 
}

const randomNumber = () => Math.floor(Math.random() * 1000);

const linkify = article => {
  console.log("ARTICLE", article);
  const factMap = {};

  let pattern = /(\(Source \d+\))/;
  let info = article.split(pattern);
  console.log('info', info);

  if (info.length < 3) return false;

  const linkifiedArticle = [];
  let factNum = 1;

  for (let i = 0; i < info.length; i += 2) {
    let data = info[i];
    let source = info[i+1];

    if (i + 1 < info.length) {
      let space = source.indexOf(' ');
      let sourceNumber = source.substring(space + 1, source.length - 1);
      console.log("Source Number", sourceNumber);

      space = data.indexOf(' ', 10);
      let link = `<a href="http://t${sourceNumber}.co?">${data.substring(0, space)}</a>${data.substring(space)}`
      //let factId = uuidv4();
      linkifiedArticle.push(link);
    } else {
      linkifiedArticle.push(data);
    }
  }

  article = linkifiedArticle.join(' ');

  return {
    article,
    factMap
  }
}

const factifyTheArticle = article => {
  console.log("ARTICLE", article);
  const factMap = {};

  let pattern = /(\(Source \d+\))/;
  let info = article.split(pattern);
  console.log('info', info);

  const factifiedArticle = [];
  let factNum = 1;

  for (let i = 0; i < info.length; i += 2) {
    let data = info[i];
    let source = info[i+1];

    if (i + 1 < info.length) {
      let space = source.indexOf(' ');
      let sourceNumber = source.substring(space + 1, source.length - 1);
      console.log("Source Number", sourceNumber);
      //let factId = uuidv4();
      factifiedArticle.push(`${data} [Fact ${randomNumber()}]`);
    } else {
      factifiedArticle.push(data);
    }
  }

  article = factifiedArticle.join(' ');

  return {
    article,
    factMap
  }
}

// const reduceSources = (article, maxCitations = 1) => {
//   console.log("ARTICLE", article);
//   const factMap = {};
//   const sourceCount = [];

//   let pattern = /(\(Source \d+\))/;
//   let info = article.split(pattern);
//   console.log('info', info);

//   const factifiedArticle = [];
//   let factNum = 1;

//   for (let i = 0; i < info.length; i += 2) {
//     let data = info[i];
//     let source = info[i+1];

//     if (i + 1 < info.length) {
//       let space = source.indexOf(' ');
//       let sourceNumber = source.substring(space + 1, source.length - 1);
      
//       sourceCount[sourceNumber] = typeof sourceCount[sourceNumber] === 'undefined' ? 1 : sourceCount[sourceNumber] + 1;
//       console.log("Source Number", sourceNumber, sourceCount);
      
//       if (sourceCount[sourceNumber] <= maxCitations) factifiedArticle.push(`${data} [Fact ${randomNumber()}]`);
//       else factifiedArticle.push(data);
//     } else {
//       factifiedArticle.push(data);
//     }
//   }

//   article = factifiedArticle.join(' ').replaceAll(' .', '.').replaceAll(' ,', ',');

//   return {
//     article,
//     factMap
//   }
// }

// const processMixLinksOrig = async (mix, socket) => {
//   let outputType;
//   switch (mix.output.type) {
//     case 'news':
//       outputType = 'news article';
//       break;
//     case 'blog':
//       outputType = 'blog post';
//       break;
//     case 'summary':
//       outputType = 'summary';
//       break;
//     case 'outline':
//       outputType = 'outline';
//       break;
//     case 'marketing':
//       outputType = 'marketing collateral';
//       break;
//   }
  
//   socket.emit('msg', {status: 'success', msg: 'Retrieving contents'});

//   /*
//    * get text
//    */
//   await extractText(mix);

//   socket.emit('text', mix.content);
//   socket.emit('msg', {status: 'success', msg: ''});

//   /*
//    * split text into chunks
//    */
//   for (let i = 0; i < mix.content.length; ++i) {
//     if (!mix.content[i].text) mix.content[i].chunks = [];
//     else mix.content[i].chunks = nlp.getTokenChunks(mix.content[i].text);
//   }

//   setTimeout(()=>{
//     socket.emit('msg', {status: 'success', msg: ''})
//     socket.emit('chunks', mix.content);
//   }, 5000);

//   /*
//    * Extract information from chunks
//    */

//   let promises = [];
//   for (let i = 0; i < mix.content.length; ++i) {
//     mix.content[i].info = [];
//     for (let j = 0; j < mix.content[i].chunks.length; ++j) {
//       promises.push(getInfoLinks(mix, i, j, 20))
//     }
//   }

//   console.log('awaiting info promises', promises.length);
//   await Promise.all(promises);

//   socket.emit('info', mix.content);

//   console.log('mix.content', JSON.stringify(mix.content, null, 4));

//   let accordingToList = [];

//   for (let i = 0; i < mix.content.length; ++i) {
//     for (let j = 0; j < mix.content[i].info.length; ++j) {
//       if (mix.content[i].info[j].facts) {
//         for (let k = 0; k < mix.content[i].info[j].facts.length; ++k) {
//           accordingToList.push({id: mix.content[i].id, fact: mix.content[i].info[j].facts[k], url: mix.content[i].url});
//         }
//       }
//       if (mix.content[i].info[j].quotes) {
//         for (let k = 0; k < mix.content[i].info[j].quotes.length; ++k) {
//           const quote = mix.content[i].info[j].quotes[k];
//           if (!quote.speaker && !quote.affiliation) continue;

//           let full = '';          
//           if (quote.speaker && quote.affiliation) full = `${quote.speaker}, ${quote.affiliation}, stated:`;
//           else full = quote.speaker ? `${quote.speaker} stated:` : `${quote.affiliation} stated: `;

//           const statement = quote.quote.startsWith('"') ? quote.quote : `"${quote.quote}"`;

//           accordingToList.push({id: mix.content[i].id, fact: `${full} ${statement}`, url: mix.content[i].url})
//         }
//       }
//     }
//   }

//   console.log(accordingToList);

//   numTokens = getNumAccordingToTokens(accordingToList);
//   console.log('INITIAL TOKENS', numTokens);

//   const maxSourceTokens = 2000;

//   while (numTokens > maxSourceTokens) {
//     randomlyRemoveFact(accordingToList);
//     numTokens = getNumAccordingToTokens(accordingToList);
//     //console.log('numTokens', numTokens);
//   }
  
//   console.log(accordingToList);

//   console.log('AccordingToList NUM TOKENS', numTokens);
//   console.log('AccordingToList NUM WORDS', accordingToList.join("\n").split(' ').length);
  
//   let sourceList = '';
//   let curId = '---';
//   const sourceMap = [];

//   let num = 0;
//   sourceMap[0] = '';
//   for (let i = 0; i < accordingToList.length; ++i) {
//     if (curId !== accordingToList[i].id) {
//       //sourceList += i > 0 ? `\nSource ${accordingToList[i].id}:\n` : `Source ${accordingToList[i].id}:\n`;
//       ++num;
//       sourceList += i > 0 ? `\nSource ${num}:\n` : `Source ${num}:\n`;
//       curId = accordingToList[i].id;
//       sourceMap[num] = accordingToList[i].url;
//     }
//     sourceList += `\t${accordingToList[i].fact}\n`;
//   }

//   console.log(sourceList);
//   console.log('SOURCE MAP', sourceMap);

//   let prompt = `'~~~Below is a list of facts from various Source IDs. Using 1100 words, write a highly dynamic, engaging news article regarding the following topic: ${mix.topic}. 
//   Each and every sentence of the returned content must be annotated with the Source ID for that sentence.
  
//   ${sourceList}~~~\n`

//   let article = await ai.getDivinciResponse(prompt);

//   console.log("ARTICLE", article);

//   prompt = `"""Below is an article with the source of each fact annotated. Using 1300 words, write a very engaging, dynamic article preserving the source annotations for each fact.
//   [Format Guide: The return format should be in HTML using subheadings for oranization.]
  
//   Article:
//   ${article}'''
//   `

//   const refinedArticle = await ai.getDivinciResponse(prompt);
//   console.log('REFINED ARTICLE', refinedArticle);

//   //const linkifiedArticle = await linkifyArticle(refinedArticle, sourceMap);

//   socket.emit('rawArticle', {rawArticle: refinedArticle})
  
  
// }

// const processMixLinksSecond = async (mix, socket) => {
//   let outputType;
//   switch (mix.output.type) {
//     case 'news':
//       outputType = 'news article';
//       break;
//     case 'blog':
//       outputType = 'blog post';
//       break;
//     case 'summary':
//       outputType = 'summary';
//       break;
//     case 'outline':
//       outputType = 'outline';
//       break;
//     case 'marketing':
//       outputType = 'marketing collateral';
//       break;
//   }
  
//   socket.emit('msg', {status: 'success', msg: 'Retrieving contents'});

//   /*
//    * get text
//    */
//   await extractText(mix);

//   socket.emit('text', mix.content);
//   socket.emit('msg', {status: 'success', msg: ''});

//   /*
//    * split text into chunks
//    */
//   for (let i = 0; i < mix.content.length; ++i) {
//     if (!mix.content[i].text) mix.content[i].chunks = [];
//     else mix.content[i].chunks = nlp.getTokenChunks(mix.content[i].text);
//   }

//   setTimeout(()=>{
//     socket.emit('msg', {status: 'success', msg: ''})
//     socket.emit('chunks', mix.content);
//   }, 5000);

//   /*
//    * Extract information from chunks
//    */

//   let promises = [];
//   for (let i = 0; i < mix.content.length; ++i) {
//     mix.content[i].info = [];
//     for (let j = 0; j < mix.content[i].chunks.length; ++j) {
//       promises.push(getInfoLinks(mix, i, j, 20))
//     }
//   }

//   console.log('awaiting info promises', promises.length);
//   await Promise.all(promises);

//   socket.emit('info', mix.content);

//   console.log('mix.content', JSON.stringify(mix.content, null, 4));

//   let accordingToList = [];

//   for (let i = 0; i < mix.content.length; ++i) {
//     for (let j = 0; j < mix.content[i].info.length; ++j) {
//       if (mix.content[i].info[j].facts) {
//         for (let k = 0; k < mix.content[i].info[j].facts.length; ++k) {
//           accordingToList.push({id: mix.content[i].id, fact: mix.content[i].info[j].facts[k], url: mix.content[i].url});
//         }
//       }
//       if (mix.content[i].info[j].quotes) {
//         for (let k = 0; k < mix.content[i].info[j].quotes.length; ++k) {
//           const quote = mix.content[i].info[j].quotes[k];
//           if (!quote.speaker && !quote.affiliation) continue;

//           let full = '';          
//           if (quote.speaker && quote.affiliation) full = `${quote.speaker}, ${quote.affiliation}, stated:`;
//           else full = quote.speaker ? `${quote.speaker} stated:` : `${quote.affiliation} stated: `;

//           const statement = quote.quote.startsWith('"') ? quote.quote : `"${quote.quote}"`;

//           accordingToList.push({id: mix.content[i].id, fact: `${full} ${statement}`, url: mix.content[i].url})
//         }
//       }
//     }
//   }

//   console.log(accordingToList);

//   numTokens = getNumAccordingToTokens(accordingToList);
//   console.log('INITIAL TOKENS', numTokens);

//   const maxSourceTokens = 2000;

//   while (numTokens > maxSourceTokens) {
//     randomlyRemoveFact(accordingToList);
//     numTokens = getNumAccordingToTokens(accordingToList);
//     //console.log('numTokens', numTokens);
//   }
  
//   console.log(accordingToList);

//   console.log('AccordingToList NUM TOKENS', numTokens);
//   console.log('AccordingToList NUM WORDS', accordingToList.join("\n").split(' ').length);
  
//   let sourceList = '';
//   let curId = '---';
//   const sourceMap = [];

//   let num = 0;
//   sourceMap[0] = '';
//   for (let i = 0; i < accordingToList.length; ++i) {
//     if (curId !== accordingToList[i].id) {
//       //sourceList += i > 0 ? `\nSource ${accordingToList[i].id}:\n` : `Source ${accordingToList[i].id}:\n`;
//       ++num;
//       sourceList += i > 0 ? `\nSource ${num}:\n` : `Source ${num}:\n`;
//       curId = accordingToList[i].id;
//       sourceMap[num] = accordingToList[i].url;
//     }
//     sourceList += `\t${accordingToList[i].fact}\n`;
//   }

//   console.log(sourceList);
//   console.log('SOURCE MAP', sourceMap);

//   let prompt = `'~~~Below is a list of facts from various Source IDs. Using 1100 words, write a highly dynamic, engaging news article regarding the following topic: ${mix.topic}. 
//   Each and every sentence of the returned content must be annotated with the Source ID for that sentence.
  
//   ${sourceList}~~~\n`

//   let article = await ai.getDivinciResponse(prompt);

//   console.log("ARTICLE", article);

//   let factifiedArticle = factifyTheArticle(article);
//   article = factifiedArticle.article;


//   prompt = `"""Below is an article with the source of each fact annotated. Using 1300 words, write a very engaging, dynamic article preserving the source annotations for each fact.
//   [Format Guide: The return format should be in HTML using subheadings for oranization.]
  
//   Article:
//   ${article}'''
//   `
  
//   const refinedArticle = await ai.getDivinciResponse(prompt);
//   console.log('REFINED ARTICLE', refinedArticle);

//   //const linkifiedArticle = await linkifyArticle(refinedArticle, sourceMap);

//   socket.emit('rawArticle', {rawArticle: refinedArticle})
  
  
// }

const processMixLinks = async (mix, socket) => {
  const linksUsed = getLinksUsed(mix);

  let outputType;
  switch (mix.output.type) {
    case 'news':
      outputType = 'news article';
      break;
    case 'blog':
      outputType = 'blog post';
      break;
    case 'summary':
      outputType = 'summary';
      break;
    case 'outline':
      outputType = 'outline';
      break;
    case 'marketing':
      outputType = 'marketing collateral';
      break;
  }
  
  socket.emit('msg', {status: 'success', msg: 'Retrieving contents'});

  /*
   * get text
   */
  await extractText(mix);

  socket.emit('text', mix.content);
  socket.emit('msg', {status: 'success', msg: ''});

  /*
   * split text into chunks
   */
  for (let i = 0; i < mix.content.length; ++i) {
    if (!mix.content[i].text) mix.content[i].chunks = [];
    else mix.content[i].chunks = nlp.getTokenChunks(mix.content[i].text);
  }

  setTimeout(()=>{
    socket.emit('msg', {status: 'success', msg: ''})
    socket.emit('chunks', mix.content);
  }, 5000);

  /*
   * Extract information from chunks
   */

  let promises = [];
  for (let i = 0; i < mix.content.length; ++i) {
    mix.content[i].info = [];
    for (let j = 0; j < mix.content[i].chunks.length; ++j) {
      promises.push(getInfoLinks(mix, i, j, 20))
    }
  }

  console.log('awaiting info promises', promises.length);
  await Promise.all(promises);

  socket.emit('info', mix.content);

  console.log('mix.content', JSON.stringify(mix.content, null, 4));

  let accordingToList = [];

  for (let i = 0; i < mix.content.length; ++i) {
    for (let j = 0; j < mix.content[i].info.length; ++j) {
      if (mix.content[i].info[j].facts) {
        for (let k = 0; k < mix.content[i].info[j].facts.length; ++k) {
          accordingToList.push({id: mix.content[i].id, fact: mix.content[i].info[j].facts[k], url: mix.content[i].url});
        }
      }
      if (mix.content[i].info[j].quotes) {
        for (let k = 0; k < mix.content[i].info[j].quotes.length; ++k) {
          const quote = mix.content[i].info[j].quotes[k];
          if (!quote.speaker && !quote.affiliation) continue;

          let full = '';          
          if (quote.speaker && quote.affiliation) full = `${quote.speaker}, ${quote.affiliation}, stated:`;
          else full = quote.speaker ? `${quote.speaker} stated:` : `${quote.affiliation} stated: `;

          const statement = quote.quote.startsWith('"') ? quote.quote : `"${quote.quote}"`;

          accordingToList.push({id: mix.content[i].id, fact: `${full} ${statement}`, url: mix.content[i].url})
        }
      }
    }
  }

  console.log(accordingToList);

  numTokens = getNumAccordingToTokens(accordingToList);
  console.log('INITIAL TOKENS', numTokens);

  const maxSourceTokens = 2000;

  while (numTokens > maxSourceTokens) {
    randomlyRemoveFact(accordingToList);
    numTokens = getNumAccordingToTokens(accordingToList);
    //console.log('numTokens', numTokens);
  }
  
  console.log(accordingToList);

  console.log('AccordingToList NUM TOKENS', numTokens);
  console.log('AccordingToList NUM WORDS', accordingToList.join("\n").split(' ').length);
  
  let sourceList = '';
  let curId = '---';
  const sourceMap = [];

  let num = 0;
  sourceMap[0] = '';
  for (let i = 0; i < accordingToList.length; ++i) {
    if (curId !== accordingToList[i].id) {
      //sourceList += i > 0 ? `\nSource ${accordingToList[i].id}:\n` : `Source ${accordingToList[i].id}:\n`;
      ++num;
      sourceList += i > 0 ? `\nSource ${num}:\n` : `Source ${num}:\n`;
      curId = accordingToList[i].id;
      sourceMap[num] = accordingToList[i].url;
    }
    sourceList += `\t${accordingToList[i].fact}\n`;
  }

  console.log(sourceList);
  console.log('SOURCE MAP', sourceMap);

  let count = 0;
  let successFlag = false;
  let factifiedArticle;

  while (count < 5 && !successFlag) {
    console.log("TRYING", count);

    let prompt = `'~~~Below is a list of facts from various Source IDs. Using 1100 words, write a highly dynamic, engaging news article regarding the following topic: ${mix.topic}. 
    Each and every sentence of the returned content must be annotated with the Source ID for that sentence.
    
    ${sourceList}~~~\n`
  
    let article = await ai.getDivinciResponse(prompt);
  
    console.log("ARTICLE", article);
  
    factifiedArticle = factifyTheArticle(article);
    console.log('REDUCED SOURCE ARTICLE', factifiedArticle);
  
    if (factifiedArticle === false) ++count;
    else successFlag = true;
  }

  article = factifiedArticle.article;


  prompt = `"""Below is an article with the source of each fact annotated. Using 1300 words, create a very engaging, dynamic article while preserving the source annotations for each fact.
  ${`${mix.html.headings ? `[Format Guide: The return format should be in HTML using subheadings for oranization.]` : ''}`}
  
  Article:
  ${article}'''
  `

  let refinedArticle = await ai.getDivinciResponse(prompt);
  console.log('REFINED ARTICLE', refinedArticle);

  //const linkifiedArticle = await linkifyArticle(refinedArticle, sourceMap);
  sendTagsAndTitles(refinedArticle, socket);

  refinedArticle = await attachPymnts(refinedArticle);

  refinedArticle = attachLinksUsed(refinedArticle, linksUsed);
  
  socket.emit('rawArticle', {rawArticle: refinedArticle});

  
}

const handleUpload = async (upload, socket) => {
  const {article, title, titles, tags, login, content, topic, output, html} = upload;
  const { username, password } = login;
  
  const settings = {
    title,
    titles,
    tags,
    login,
    content,
    topic,
    output,
    html
  }

  try {
    const id = await wp.createPost (`delta.pymnts.com`, username, password, title, article, tags, titles, 'draft', socket);
  
    const q = `INSERT INTO wordpress_articles (id, article, settings) VALUES ("wp-${id}", ${mysql.escape(article)}, ${mysql.escape(JSON.stringify(settings))})`;

    const result = await query(q);

    console.log('db result', result);

  } catch (err) {
    console.error (err);

  }

}

// const processMixLinksAndQuotes = async (mix, socket) => {
//   let outputType;
//   switch (mix.output.type) {
//     case 'news':
//       outputType = 'news article';
//       break;
//     case 'blog':
//       outputType = 'blog post';
//       break;
//     case 'summary':
//       outputType = 'summary';
//       break;
//     case 'outline':
//       outputType = 'outline';
//       break;
//     case 'marketing':
//       outputType = 'marketing collateral';
//       break;
//   }
  
//   socket.emit('msg', {status: 'success', msg: 'Retrieving contents'});

//   /*
//    * get text
//    */
//   await extractText(mix);

//   socket.emit('text', mix.content);
//   socket.emit('msg', {status: 'success', msg: ''});

//   /*
//    * split text into chunks
//    */
//   for (let i = 0; i < mix.content.length; ++i) {
//     if (!mix.content[i].text) mix.content[i].chunks = [];
//     else mix.content[i].chunks = nlp.getTokenChunks(mix.content[i].text);
//   }

//   setTimeout(()=>{
//     socket.emit('msg', {status: 'success', msg: ''})
//     socket.emit('chunks', mix.content);
//   }, 5000);

//   /*
//    * Extract information from chunks
//    */

//   let promises = [];
//   for (let i = 0; i < mix.content.length; ++i) {
//     mix.content[i].info = [];
//     for (let j = 0; j < mix.content[i].chunks.length; ++j) {
//       promises.push(getInfoLinks(mix, i, j, mix.content[i].chunks.length))
//     }
//   }

//   console.log('awaiting info promises', promises.length);
//   await Promise.all(promises);

//   socket.emit('info', mix.content);

//   console.log('mix.content', JSON.stringify(mix.content, null, 4));

//   let accordingToList = [];

//   for (let i = 0; i < mix.content.length; ++i) {
//     for (let j = 0; j < mix.content[i].info.length; ++j) {
//       if (mix.content[i].info[j].facts) {
//         for (let k = 0; k < mix.content[i].info[j].facts.length; ++k) {
//           accordingToList.push({id: mix.content[i].id, fact: mix.content[i].info[j].facts[k]});
//         }
//       }
//       if (mix.content[i].info[j].quotes) {
//         for (let k = 0; k < mix.content[i].info[j].quotes.length; ++k) {
//           const quote = mix.content[i].info[j].quotes[k];
//           if (!quote.speaker && !quote.affiliation) continue;

//           let full = '';          
//           if (quote.speaker && quote.affiliation) full = `${quote.speaker}, ${quote.affiliation}, stated:`;
//           else full = quote.speaker ? `${quote.speaker} stated:` : `${quote.affiliation} stated: `;

//           const statement = quote.quote.startsWith('"') ? quote.quote : `"${quote.quote}"`;

//           accordingToList.push({id: mix.content[i].id, fact: `${full} ${statement}`})
//         }
//       }
//     }
//   }

//   console.log(accordingToList);

//   numTokens = getNumAccordingToTokens(accordingToList);
//   //console.log('numTokens', numTokens);

//   while (numTokens > 2000) {
//     randomlyRemoveFact(accordingToList);
//     numTokens = getNumAccordingToTokens(accordingToList);
//     //console.log('numTokens', numTokens);
//   }
  
//   console.log(accordingToList);
//   console.log('AccordingToList NUM TOKENS', numTokens);
//   console.log('AccordingToList NUM WORDS', accordingToList.split(' ').length);

//   let sourceList = '';
//   let curId = '---';

//   let num = 0;
//   for (let i = 0; i < accordingToList.length; ++i) {
//     if (curId !== accordingToList[i].id) {
//       //sourceList += i > 0 ? `\nSource ${accordingToList[i].id}:\n` : `Source ${accordingToList[i].id}:\n`;
//       sourceList += i > 0 ? `\nSource ${++num}:\n` : `Source ${++num}:\n`;
//       curId = accordingToList[i].id;
//     }
//     sourceList += `\t${accordingToList[i].fact}\n`;
//   }

//   console.log(sourceList);

//   let prompt = `"""Below is a list of facts from various Source IDs. Using 1300 words, write a highly dynamic, engaging news article regarding the following topic: ${mix.topic}.
//   [Format Guide: Annotate each and every sentence in the returned content with the Source ID for that sentence.]
  
//   ${sourceList}"""
//   `

//   let article = await ai.getDivinciResponse(prompt);

//   console.log("ARTICLE", article);

//   prompt = `"""Below is an article with the source of each fact annotated. Using 1300 words, write a very engaging, dynamic article preserving the source annotations for each fact.
//   [Format Guide: The return format should be in HTML using subheadings for oranization.]
  
//   Article:
//   ${article}"""
//   `

//   const refinedArticle = await ai.getDivinciResponse(prompt);

//   socket.emit('rawArticle', {rawArticle: refinedArticle})
//   console.log('REFINED ARTICLE', refinedArticle);
// }



const handleSocketEvents = async socket => {
  socket.on('mix', mix => {
    const { html } = mix;
    if (html.links) processMixLinks(mix, socket);
    else processMix(mix, socket);
  })

  socket.on('upload', upload => handleUpload(upload, socket));

  socket.join('seeds');

  sendSeeds(socket);

  //socket.on('mix', (mix) => processMixLinks(mix, socket))
  //socket.on('mix', (mix) => processMix(mix, socket))
}

const httpsServer = https.createServer({
    key: fs.readFileSync(privateKeyPath),
    cert: fs.readFileSync(fullchainPath),
  }, app);
  

  httpsServer.listen(listenPort, '0.0.0.0', () => {
    console.log(`HTTPS Server running on port ${listenPort}`);
});

const io = require('socket.io')(httpsServer, {
  cors: {
    origin: [
      "http://localhost:3000",
      'https://blender.pymnts.com'
    ],
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
  
  // if(socket.request.session.name !== undefined){
  //   socket.emit('name', socket.request.session.name); // notice socket.io has access to session.name
  //   io.emit('event', socket.request.session.name + ' has joined!');
  // }

  console.log('connected', socket.id);
  handleSocketEvents(socket);
  // socket.on('name', (name) => {
  //   socket.request.session.name = name; // add name to the session object
  //   socket.request.session.save(); // save the session object to persist through other requests
  //   socket.broadcast.emit('event', name + ' says hello!');
  // });
});


const test = async () => {
  let text = `Inflation has been on the rise across the US for the past two years, with San Diego having one of the highest inflation rates in the nation. According to the US Bureau of Labor Statistics, San Diego County prices increased 5.2 percent in the 12 months ending in May (Source 1). Tampa had the highest inflation rate, up 7.3 percent, while Minneapolis had the lowest rate, 1.8 percent, and urban Hawaii was 2 percent (Source 1). San Diego County's inflation rate was pushed up the last two months by cereal and bakery products, rent, and used car prices going up again (Source 1). In contrast, the Twin Cities had a 1.8% inflation rate in May, while Honolulu had a 2% inflation rate (Source 3).

  Alan Gin, an economist at the University of San Diego, said higher numbers in San Diego have been the result of electricity and housing costs (Source 1). San Diego could have more pressure on housing costs than other areas of California because its population isn't dropping (Source 1). San Diego County added 1,254 people, while Los Angeles County lost 90,704; San Francisco County lost 2,816; and Orange County lost 9,821 (Source 1). The highest inflation rise in San Diego County in recent years was 8.3 percent in May (Source 1). Chicago Fed economists stated that housing is the main driver of regional differences in inflation (Source 3).
  
  The Consumer Price Index rose only 1.8% in the Twin Cities year over year in May as two years of red-hot inflation finally looks to be cooling off (Source 2). Prices are actually decreasing in several categories in the Twin Cities, such as natural gas prices (down 10.2%), cereal and baked goods (down 4.9%), fruits and vegetables (down 2%), and household furnishing prices (down 3.6%) (Source 2).
  
  The Fed has been raising interest rates for 15 months in hopes of quelling the hottest inflation since the 1980s (Source 3). The primary factor driving these geographic variations in inflation is housing (Source 3). Residents of the Midwest generally spend a smaller share of their budgets on keeping a roof over their head than people in the Northeast or West (Source 3). With housing a huge contributor to recent inflation increases, inflation in the Midwest has been more muted this year (Source 3).
  
  Transportation is another factor in inflation's regional differences, exacerbated last year as the price of gasoline and used cars skyrocketed (Source 3). Just as cities with more housing can better withstand shelter inflation, a city with a robust mass transit system will depend less on car and motor fuel prices than a region where most people drive (Source 3).
  
  Thanks in part to a population exodus during the pandemic, prices in Honolulu have risen at a slower pace than elsewhere around the US (Source 3). Annual inflation there peaked at 7.5% in March of last year, four months before the nation's inflation rate hit 9.1% (Source 3). Since then, falling population, combined with an increase in housing, helped shelter costs in the area grow only modestly—and, with prices for energy and used cars and trucks falling, overall inflation fell to a 2% rate last month (Source 3). Likewise, increased housing construction in Minnesota's Twin Cities has helped ease price increases (Source 3). The cost of shelter there is rising at just 4% a year, half the national rate (Source 3).
  
  On the plus side for San Diegans, inflation rose 0.9 percent in April and May, its lowest two-month rise this year (Source 1). When volatile food and energy costs are removed from the overall inflation rate, San Diego County had a 7.1 percent yearly increase (Source 1). Across the nation in March, the West had the biggest annual rise at 4.5 percent, outpacing the South (4.4 percent), Midwest (3.7 percent) and Northeast (3.1 percent) (Source 1).
  
  Workers pay is finally staying ahead of inflation, as real earnings in May turned positive for the first time in over two years (Source 3). Inflation falls in May to lowest level in 2 years (Source 3). Transportation costs, which include automobile maintenance, vehicle parts and car insurance, were down 3.1 percent (Source 1). Medical care costs were up 4.6 percent (Source 1). Apparel costs were up 10.2 percent (Source 1).
  
  Inflation is a complex issue that affects people in different ways in different parts of the US. While San Diego has one of the highest inflation rates in the nation, other regions, such as Minneapolis and Honolulu, have seen inflation ease toward historical averages. However, with housing being a major contributor to recent inflation increases, prices in other regions, such as Miami, Tampa, and Dallas, have seen a huge jump in shelter costs. For now, workers pay is staying ahead of inflation, but only time will tell how long this trend will last.
  ARTICLE Inflation has been on the rise across the US for the past two years, with San Diego having one of the highest inflation rates in the nation. According to the US Bureau of Labor Statistics, San Diego County prices increased 5.2 percent in the 12 months ending in May (Source 1). Tampa had the highest inflation rate, up 7.3 percent, while Minneapolis had the lowest rate, 1.8 percent, and urban Hawaii was 2 percent (Source 1). San Diego County's inflation rate was pushed up the last two months by cereal and bakery products, rent, and used car prices going up again (Source 1). In contrast, the Twin Cities had a 1.8% inflation rate in May, while Honolulu had a 2% inflation rate (Source 3).
  
  Alan Gin, an economist at the University of San Diego, said higher numbers in San Diego have been the result of electricity and housing costs (Source 1). San Diego could have more pressure on housing costs than other areas of California because its population isn't dropping (Source 1). San Diego County added 1,254 people, while Los Angeles County lost 90,704; San Francisco County lost 2,816; and Orange County lost 9,821 (Source 1). The highest inflation rise in San Diego County in recent years was 8.3 percent in May (Source 1). Chicago Fed economists stated that housing is the main driver of regional differences in inflation (Source 3).
  
  The Consumer Price Index rose only 1.8% in the Twin Cities year over year in May as two years of red-hot inflation finally looks to be cooling off (Source 2). Prices are actually decreasing in several categories in the Twin Cities, such as natural gas prices (down 10.2%), cereal and baked goods (down 4.9%), fruits and vegetables (down 2%), and household furnishing prices (down 3.6%) (Source 2).
  
  The Fed has been raising interest rates for 15 months in hopes of quelling the hottest inflation since the 1980s (Source 3). The primary factor driving these geographic variations in inflation is housing (Source 3). Residents of the Midwest generally spend a smaller share of their budgets on keeping a roof over their head than people in the Northeast or West (Source 3). With housing a huge contributor to recent inflation increases, inflation in the Midwest has been more muted this year (Source 3).
  
  Transportation is another factor in inflation's regional differences, exacerbated last year as the price of gasoline and used cars skyrocketed (Source 3). Just as cities with more housing can better withstand shelter inflation, a city with a robust mass transit system will depend less on car and motor fuel prices than a region where most people drive (Source 3).
  
  Thanks in part to a population exodus during the pandemic, prices in Honolulu have risen at a slower pace than elsewhere around the US (Source 3). Annual inflation there peaked at 7.5% in March of last year, four months before the nation's inflation rate hit 9.1% (Source 3). Since then, falling population, combined with an increase in housing, helped shelter costs in the area grow only modestly—and, with prices for energy and used cars and trucks falling, overall inflation fell to a 2% rate last month (Source 3). Likewise, increased housing construction in Minnesota's Twin Cities has helped ease price increases (Source 3). The cost of shelter there is rising at just 4% a year, half the national rate (Source 3).
  
  On the plus side for San Diegans, inflation rose 0.9 percent in April and May, its lowest two-month rise this year (Source 1). When volatile food and energy costs are removed from the overall inflation rate, San Diego County had a 7.1 percent yearly increase (Source 1). Across the nation in March, the West had the biggest annual rise at 4.5 percent, outpacing the South (4.4 percent), Midwest (3.7 percent) and Northeast (3.1 percent) (Source 1).
  
  Workers pay is finally staying ahead of inflation, as real earnings in May turned positive for the first time in over two years (Source 3). Inflation falls in May to lowest level in 2 years (Source 3). Transportation costs, which include automobile maintenance, vehicle parts and car insurance, were down 3.1 percent (Source 1). Medical care costs were up 4.6 percent (Source 1). Apparel costs were up 10.2 percent (Source 1).
  
  Inflation is a complex issue that affects people in different ways in different parts of the US. While San Diego has one of the highest inflation rates in the nation, other regions, such as Minneapolis and Honolulu, have seen inflation ease toward historical averages. However, with housing being a major contributor to recent inflation increases, prices in other regions, such as Miami, Tampa, and Dallas, have seen a huge jump in shelter costs. For now, workers pay is staying ahead of inflation, but only time will tell how long this trend will last.`;

  const keywords = await getTopics(text);

  console.log('KEYWORDS', keywords);
}

const test2 = async () => {
  let result = await createLink(`According to the US Bureau of Labor Statistics, San Diego County prices increased 5.2 percent in the 12 months ending in May (Source 1).`, 'https://cnn.com');

  console.log(result);
}

//test2();

