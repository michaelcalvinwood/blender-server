require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const articleExtractor = require('@extractus/article-extractor');
const fs = require('fs');

const { convert } = require('html-to-text');

const { SCRAPERAPI_KEY } = process.env;

//const url = 'https://www.pymnts.com/news/retail/2023/will-consumers-pay-50-for-drugstore-brand-sunscreen/';

exports.urlType = url => {
    console.log('urlType', url);

    const base = url.substring(url.lastIndexOf('/')+1);

    const loc = base.lastIndexOf('.');

    if (loc === -1) return 'html';

    const extension = base.substring(loc+1).toLowerCase();

    return extension;
}

exports.getHTML = async url => {
  let request = {
      url: 'http://api.scraperapi.com',
      params: {
        api_key: SCRAPERAPI_KEY,
        url
      },
      method: 'get',
      headers: {
        "Content-Type": "application/json"
      }
    }
  
    let response;
  
    try {
      response = await axios(request);
    } catch (err) {
      console.error('articleExtractor error:', err);
      return false;
    }
  
    return response.data;
}

exports.extractArticleFromHTML = async (html, url = '') => {
    console.log('extractArticleFromHTML html type', typeof html);
    if (typeof html !== 'string') return '';

    console.log('extractArticleFromHTML html length', html.length);

    let article;
    
    if (url) article =  await articleExtractor.extractFromHtml(html, url);
    else article = await articleExtractor.extractFromHtml(html);

    if (article && article.title && article.content) return `<h1>${article.title}</h1>\n${article.content}`;

    return '';
}

exports.getTextFromHTML = html => {
  const options = {
      selectors: [
        { selector: 'a', options: { ignoreHref: true } },
        { selector: 'a.button', format: 'skip' }
      ]
    }
    
    let text = convert(html, options);
    let lines = text.split("\n");
    for (let i = 0; i < lines.length; ++i) {
      if (lines[i]) lines[i] = lines[i].trim();
      else lines[i] = "\n";
    }
    text = lines.join(' ');

    return text;
}

exports.articleExtractor = async (url, html = false) => {
  const body = await exports.getHTML(url);

  if (body === false) return false;

  let article = await articleExtractor.extractFromHtml(body, url);
  if (!article) return false;
   
  text = getTextFromHTML(article.content);

  return {title: article.title, text, html: article.content, url};
}

exports.articleTextExtractor = async (body) => {
  articleExtractor.setSanitizeHtmlOptions({parseStyleAttributes: false});
  let article = await articleExtractor.extractFromHtml(body);
  console.log('returned article', article);
  if (!article) {
    article = {
      title: 'seed',
      content: body
    }
  }
  
  text = exports.getTextFromHTML(article.content);

  return {title: article.title, text, html: article.content, url: 'seed'};
}

exports.isUrl = url => {
  try {
    const test = new URL(url);
  } catch (err) {
    return false;
  }

  return true;
}



exports.download = async (url, filePath) => {  
  return new Promise(async (resolve, reject) => {
      const writer = fs.createWriteStream(filePath)
  
      let response;

      try {
          response = await axios({
          url,
          method: 'GET',
          responseType: 'stream'
          })
      } catch (e) {
          console.error(e);
          reject(e);
          return false;
      }
      response.data.pipe(writer)

      writer.on('finish', resolve)
      writer.on('error', reject)
  })
}
