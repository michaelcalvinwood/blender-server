const listenPort = 6256;
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

const urlUtils = require('./utils/url');
const wp = require('./utils/wordpress');
const ai = require('./utils/ai');
const convert = require('./utils/conversion');
const nlp = require('./utils/nlp');
const dom = require('./utils/dom');

const app = express();
app.use(express.static('public'));
app.use(express.json({limit: '200mb'})); 
app.use(cors());

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

app.post('/login', (req, res) => handleLogin(req, res));

app.get('/', (req, res) => {
    res.send('Hello, World!');
});

/*
 * Socket Functions
 */

const extractUrlText = async (mix, index) => {
  const url = mix.content[index].url;

  const urlType = urlUtils.urlType(url);  // later add function here to get the type

  let text, fileName;

  switch (urlType) {
    case 'html':
      const html = await urlUtils.getHTML(url);
      const article = await urlUtils.extractArticleFromHTML(html);
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

    mix.content[index].text = text;
      
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
      promises.push(getSummary(mix, i, j))
    }
  }

  await Promise.all(promises);
}

const writeAbout = async (articlePart, topic, outputType) => {
  prompt = `"""Below are a set of Facts. In ${Math.ceil(articlePart.tokens/2) < 800 ? Math.ceil(articlePart.tokens/2) : 800} words, write a highly engaging, dynamic ${outputType} using as many facts as possible.
  
  ${articlePart.facts}"""
  `

  console.log('PROMPT', prompt);

  articlePart.part = await ai.getChatText(prompt);
  articlePart.partWords = articlePart.part.split(' ').length;
  articlePart.partTokens = nlp.numGpt3Tokens(articlePart.part);

}

const reduceArticlePart = async (articlePart, keepPercent) => {
  prompt = `"""Below is an Article. Reduce this article to ${Math.floor(articlePart.partWords * keepPercent)} words, keeping the article highly dynamic and engaging.
  
  Article:
  ${articlePart.part}"""
  `

  //console.log('PROMPT', prompt);

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
    prompt = `"""Below are ${articleParts.length} Articles. Using 800 words, rewrite these articles into a one highly engaging and dynamic 1100-word article about the following topic: ${topic}.

    [Content Guide: Make sure the returned content solely includes information related to the following topic: ${topic}.]
  
  ${articles}"""
  `
  }

  console.log('PROMPT', prompt);

  return await ai.getChatText(prompt);
}

const addSubheadings = async (mergedArticle, num, factLinks) => {

  const prompt = `"""Below is some Content. Using ${mergedArticle.numWords + 100} words, rewrite the content using HTML. Use headings, subheadings, tables, bullet points, paragraphs, and bold to organize the information.
  
  Content:
  ${mergedArticle.content}"""
  `
  
  // const prompt = `"""Below is some Content and FactLinks. Using ${mergedArticle.numWords + 100} words, rewrite the content using HTML by incorporating ${Math.ceil(factLinks.length / 3)} FactLinks verbatim, as-is.
  
  // [Format Guide: Use headings, subheadings, tables, bullet points, paragraphs, links, and bold to organize the information. There must be a minimum of ${Math.ceil(factLinks.length / 3)} FactLinks included.] 
  
  // Content:
  // ${mergedArticle.content}
  
  // FactLinks:
  // ${factLinks.join("\n")}"""
  // `
  console.log('PROMPT', prompt);
  //return await ai.getChatText(prompt);
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
  const factLinks = [];

  for (let i = 0; i < part.keyFacts.length; ++i) {
    factList.push(part.keyFacts[i].fact);
    const factLink = getFactLink(part.keyFacts[i].fact, part.keyFacts[i].keywords, `http://c.co?n=${part.num}`);
    if (factLink !== false) factLinks.push(factLink);
  }

  console.log(factLinks);

  part.factList = factList.join("\n");
  part.factsTokens = nlp.numGpt3Tokens(part.factList);
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

const processMix = async (mix, socket) => {
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
      promises.push(getInfo(mix, i, j, mix.content[i].chunks.length))
    }
  }

  console.log('awaiting info promises', promises.length);
  await Promise.all(promises);

  socket.emit('info', mix.content);

  const articleChunks = [];

  let num = 0;

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
      }
    }
  }

  /*
   * get factList, factsTokens, factLinks, and quoteLinks
   */

  for (let i = 0; i < articleChunks.length; ++i) getFactsTokens(articleChunks[i]);

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

  const maxPartTokens = 1750;
  const articleParts = [];
  let curFacts = "Facts:\n";
  let curTokens = 0;
  let articleTokens = 0;
  
  for (let i = 0; i < articleChunks.length; ++i) {
    let totalTokens = articleChunks[i].infoTokens + articleChunks[i].factsTokens;
    articleTokens += totalTokens;
    let test = curTokens + totalTokens;
    if (test <= maxPartTokens) {
      curFacts += `${articleChunks[i].info.trim()}\n${articleChunks[i].factList}`;
      curTokens += totalTokens;
    } else {
      articleParts.push({facts: curFacts, tokens: curTokens});
      curFacts = `Facts:\n${articleChunks[i].info.trim()}\n${articleChunks[i].factList}`;
      curTokens = totalTokens;
    }
  }

  if (curFacts) articleParts.push({facts: curFacts, tokens: curTokens});

  console.log("ARTICLE PARTS", articleParts);
  console.log("ARTICLE TOKENS", articleTokens);

  const mergedArticle = { content: ''}; 

  promises = [];
  for (let i = 0; i < articleParts.length; ++i) {
    promises.push(writeAbout(articleParts[i], mix.topic, outputType))
  }

  console.log('await articleParts promises', promises.length);

  await Promise.all(promises);

  //console.log('ARTICLE PARTS', articleParts);

  let totalWords = 0;
  let totalTokens = 0;

  for (let i = 0; i < articleParts.length; ++i) {
    totalWords += articleParts[i].partWords;
    totalTokens += articleParts[i].partTokens;
  }

  console.log("TOTAL TOKENS", totalTokens)

  if (totalTokens > maxPartTokens) {
    
    let count = 0;
    let keepPercent = (maxPartTokens/totalTokens);
   while (totalTokens > maxPartTokens && count <= 3) {
    keepPercent -= .1;
    console.log('keepPercent', keepPercent);

    promises = [];
    for (let i = 0; i < articleParts.length; ++i) {
      promises.push(reduceArticlePart(articleParts[i], keepPercent));
    }

    console.log('awaiting reduce promises', promises.length);
    await Promise.all(promises);

    totalTokens = 0;
    for (let i = 0; i < articleParts.length; ++i) {
      totalTokens += articleParts[i].reducedTokens;
    }

    console.log("TOTAL TOKENS", totalTokens);
    ++count;
   }

   /*
    * At this point .reduced has an acceptable totalToken count
    * It's time to merge the parts into a single article
    */

   console.log('awaiting merge')

   mergedArticle.content = await mergeArticleParts(articleParts, mix.topic);

  } else if (articleParts.length > 1) {
    for (let i = 0; i < articleParts.length; ++i) {
      articleParts[i].reduced = articleParts[i].part;
      articleParts[i].reducedWords = articleParts[i].reduced.split(' ').length;
      articleParts[i].reducedTokens = nlp.numGpt3Tokens(articleParts[i].reduced);
    } 
    mergedArticle.content = await mergeArticleParts(articleParts, mix.topic);
  } else if (articleParts.length > 0) {
    articleParts[0].reduced = articleParts[0].part;
    articleParts[0].reducedWords = articleParts[0].reduced.split(' ').length;
    articleParts[0].reducedTokens = nlp.numGpt3Tokens(articleParts[0].reduced);
    mergedArticle.content = articleParts[0].part;
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

  mergedArticle.withSubheadings = await addSubheadings(mergedArticle, 4, factLinks);

  console.log('MERGED ARTICLE', mergedArticle);

  socket.emit('rawArticle', {rawArticle: mergedArticle.withSubheadings});

  return;

  mergedArticle.subheadings = extractSubheadingSections(mergedArticle.withSubheadings);

  console.log(mergedArticle);

  mergedArticle.expandedSubheadings = [];
  promises = [];
  for (let i = 0; i < mergedArticle.subheadings.length; ++i) {
    promises.push(expandSubsection(mergedArticle, i, factLinks ));
  }

  console.log('awaiting expanding subsections', promises.length);
  await Promise.all(promises);

  console.log('MERGED ARTICLE WITH EXPANDED SUBHEADINGS', mergedArticle)

  return;



















  /*
   * Write an article based on each part
   */


  const article = [];
  promises = [];

  switch (mix.output.type) {
    case 'news':
      outputType = 'news article';
      break;
    case 'blog':
      outputType = 'blog post';
      break;
    case 'marketing':
      outputType = 'marketing piece';
      break;
  }

  for (let i = 0; i < articleParts.length; ++i) {
    let location;
    if (articleParts.length === 1) location = 'total';
    else if (i === 0) location = 'beginning';
    else if (i === articleParts.length - 1) location = 'end';
    else location = 'middle';
    promises.push(writeArticlePart(articleParts[i], mix.topic, outputType, articleParts, i, location));
  }

  console.log('waiting on article promises', promises.length);
  await Promise.all(promises);

  console.log('ARTICLE PARTS', articleParts);

  /*
   * Combine articles into one article to create the raw article
   */

  let combinedArticleParts = articleParts.join("\n");

  console.log('COMBINED ARTICLE PARTS', combinedArticleParts);
  socket.emit('rawArticle', {rawArticle: combinedArticleParts});

  return;
  console.log('article tokens', nlp.numGpt3Tokens(combinedArticleParts))

  const firstH1 = combinedArticleParts.indexOf('<h1>');
  if (firstH1 > -1) {
    const secondH1 = combinedArticleParts.substring(firstH1+4).indexOf('<h1>');
    console.log('h1s', firstH1, secondH1);
    if (secondH1 > -1) {
      const part1 = combinedArticleParts.substring(0, secondH1);
      let part2 = combinedArticleParts.substring(secondH1);

      part2 = part2.replaceAll('<h5>', '<h6>').replaceAll('</h5>', '</h6>');
      part2 = part2.replaceAll('<h4>', '<h5>').replaceAll('</h4>', '</h5>');
      part2 = part2.replaceAll('<h3>', '<h4>').replaceAll('</h3>', '</h4>');
      part2 = part2.replaceAll('<h2>', '<h3>').replaceAll('</h2>', '</h3>');
      part2 = part2.replaceAll('<h1>', '<h2>').replaceAll('</h1>', '</h2>');
      
      combinedArticleParts = part1 + part2;

      console.log('COMBINED ARTICLE PARTS #2', combinedArticleParts);
      socket.emit('rawArticle', {rawArticle: combinedArticleParts});
    }
  }

  /*
   * if more than one article part, remove introductions and conclusions
   */
  if (articleParts.length > 1) {
    $ = cheerio.load(combinedArticleParts);
    const headings = $('h1, h2, h3, h4, h5, h6');
    $(headings).each((index, el) => {
      const contents = $(el).text();
      console.log('heading content', contents);
      if (contents.toLowerCase() === 'introduction' || contents.toLowerCase() === 'conclusion') dom.removeSectionByHeading($, el);
    })
  }


  //console.log("REMOVED", $.html());

  /*  
  
  
  add in quotes
    linked quotes
  
  see if you can get the article generator to spit back the sources used.

  in any case, attach recommended reading links
  
  */

  // await writeArticle(mix);

  // socket.emit('article', mix.content);
  // socket.emit('msg', {status: 'success', msg: 'Final Article'});

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

const processMixLinks = async (mix, socket) => {
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

  return;

  let prompt = `'~~~Below is a list of facts from various Source IDs. Using 1100 words, write a highly dynamic, engaging news article regarding the following topic: ${mix.topic}. 
  Each and every sentence of the returned content must be annotated with the Source ID for that sentence.
  
  ${sourceList}~~~\n`

  let article = await ai.getDivinciResponse(prompt);

  console.log("ARTICLE", article);

  prompt = `"""Below is an article with the source of each fact annotated. Using 1300 words, write a very engaging, dynamic article preserving the source annotations for each fact.
  [Format Guide: The return format should be in HTML using subheadings for oranization.]
  
  Article:
  ${article}'''
  `

  const refinedArticle = await ai.getDivinciResponse(prompt);

  socket.emit('rawArticle', {rawArticle: refinedArticle})
  console.log('REFINED ARTICLE', refinedArticle);
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
  socket.on('mix', (mix) => processMixLinks(mix, socket))
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



