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


const urlUtils = require('./utils/url');
const wp = require('./utils/wordpress');
const ai = require('./utils/ai');
const convert = require('./utils/conversion');
const nlp = require('./utils/nlp');

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

  const result = await wp.getJWT(username, password);

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

  console.log('urlType', urlType);
  let text, fileName;

  switch (urlType) {
    case 'html':
      const html = await urlUtils.getHTML(url);
      const article = await urlUtils.extractArticleFromHTML(html);
      text = urlUtils.getTextFromHTML(article);
      /*
       * TODO: If article === false email Michael with URL
       */

      console.log('article', article);
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
      console.error('unknown urlType', urlType);
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

const getInfo = async (mix, i, j) => {
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
    Also return a list of the ten most pertinent facts that are related to the following topic: ${mix.topic}.
    The return format must be stringified JSON in the following format: {
      info: array of all the facts that related to the topic '${mix.topic}' goes here,
      quotes: array of quotes in the following format {
        speaker: the identity of the speaker goes here,
        affiliation: the organization that the speaker is affiliated with goes here,
        quote: the speaker's quote goes here
      },
      facts: array of the ten pertinent facts goes here
    }
    
    Text:
    ${info}"""
    `
    mix.content[i].info[j] = await ai.getChatJSON(prompt);
    mix.content[i].info[j].info = mix.content[i].info[j].info.join(" ");
  } else {
    // const lines = info.split("\n");
    // const sentences = [];
    // lines.forEach(line => {
    //   const candidates = nlp.getSentences(line);
    //   for (let i = 0; i < candidates.length; ++i) {
    //     const trimmed = candidates[i].trim();
    //     if (trimmed.endsWith('.') || trimmed.endsWith(':') || trimmed.endsWith('.')) sentences.push(trimmed);
    //   }
    // })

    // info = sentences.join(' ');
    // console.log("INFO", info);

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

  

  console.log(`mix.content[${i}].info[${j}]`, mix.content[i].info[j]);
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


  if (topic) {
    prompt = `"""[Return just the main response. Take out the pre-text and the post-text]
    Below are one or more Sources along with the Source numbers (#{sourceId}). These sources have Info and KeyFacts. Write a highly engaging, dynamic, long-form ${outputType} on the following topic: ${topic}; using as much Info and KeyFacts as possible that is related to that topic.
${part}"""
`
  } else {
//     prompt = `"""[Return just the main response. Take out the pre-text and the post-text]
//     Below are one or more Sources along with the Source numbers (#{sourceId}). These sources have Info and KeyFacts. Write a highly engaging, dynamic, long-form ${outputType}using as much Info and KeyFacts as possible.
// ${part}"""
// `

    prompt = `"""
Below are a set of Facts. Write a highly engaging, dynamic, long-form ${outputType} using as many of the facts as possible.
${format}
${part}"""
`
  }

  article[index] = await ai.getChatText(prompt);
}

const processMix = async (mix, socket) => {
  
  socket.emit('msg', {status: 'success', msg: 'Received contents'});

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
    socket.emit('chunks', mix.content);
  }, 5000);

  /*
   * Extract information from chunks
   */

  let promises = [];
  for (let i = 0; i < mix.content.length; ++i) {
    mix.content[i].info = [];
    for (let j = 0; j < mix.content[i].chunks.length; ++j) {
      promises.push(getInfo(mix, i, j))
    }
  }

  console.log('awaiting info promises');
  await Promise.all(promises);

  console.log('sending info');

  socket.emit('info', mix.content);

  const articleChunks = [];

  for (let i = 0; i < mix.content.length; ++i) {
    for (let j = 0; j < mix.content[i].info.length; ++j) {
      if (mix.content[i].info[j].info) {
        articleChunks.push({
          source: mix.content[i].id,
          info: mix.content[i].info[j].info,
          keyFacts: mix.content[i].info[j].facts,
          infoTokens: nlp.numGpt3Tokens(mix.content[i].info[j].info),
          factsTokens: nlp.numGpt3Tokens(mix.content[i].info[j].facts.join(' '))
        })
      }
    }
  }

  /*
   * Sort the article chunks by total tokens needed ascending
   */

  articleChunks.sort((a, b) => (a.infoTokens + a.factsTokens) - (b.infoTokens + b.factsTokens));
  console.log('ARTICLE CHUNKS', articleChunks);

  /*
   * Combine article chunks into article parts based on token size
   */

  const maxPartTokens = 2000;
  const articleParts = [];
  let curPart = "Facts:\n";
  let curLength = 0;
  
  for (let i = 0; i < articleChunks.length; ++i) {
    let totalTokens = articleChunks[i].infoTokens + articleChunks[i].factsTokens;
    let test = curLength +  totalTokens;
    if (test <= maxPartTokens) {
      curPart += `${articleChunks[i].info.trim()}\n${articleChunks[i].keyFacts.join("\n")}`;
      curLength += totalTokens;
    } else {
      articleParts.push(curPart);
      curPart = `Facts:\n${articleChunks[i].info.trim()}\n${articleChunks[i].keyFacts.join("\n")}`;
      curLength = totalTokens;
    }
  }

  if (curPart) articleParts.push(curPart);

  console.log("ARTICLE PARTS", articleParts);

  let outputType = 'news article';
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

  const combinedArticleParts = articleParts.join("\n");

  console.log('COMBINED ARTICLE PARTS', combinedArticleParts);
  socket.emit('rawArticle', {rawArticle: combinedArticleParts});

  console.log('article tokens', nlp.numGpt3Tokens(combinedArticleParts))

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

const handleSocketEvents = async socket => {
  socket.on('mix', (mix) => processMix(mix, socket))
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
