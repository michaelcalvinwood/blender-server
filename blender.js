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

const urlUtils = require('./utils/url');
const wp = require('./utils/wordpress');
const ai = require('./utils/ai');

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

  const urlType = 'html';  // later add function here to get the type

  switch (urlType) {
    case 'html':
      const html = await urlUtils.getHTML(url);
      const article = await urlUtils.extractArticleFromHTML(html);
      const text = urlUtils.getTextFromHTML(article);
      mix.content[index].text = text;
      /*
       * TODO: If article === false email Michael with URL
       */

      console.log('article', article);
      break;
    }
}

const extractText = async mix => {
  console.log('mix', JSON.stringify(mix, null, 4));
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

const chatJSON = async (mix, index, prompt, temperature = .4) => {
  mix.content[index].summary = await ai.getChatJSON(prompt, temperature);
  console.log('summary', mix.content[index].summary);
}

const extractSummaries = async (mix) => {
  console.log('mix.topic', mix.topic);

  const promises = [];

  let prompt;

  for (let i = 0; i < mix.content.length; ++i) {
    let info = mix.content[i].text;
    console.log('info', info);
    if (!info) {
      mix.content[i].summary = null;
      continue;
    }

    if (mix.topic) {
      prompt = `"""Below is some Info. Provide a detailed summary of the info as it relates to the following topic: ${mix.topic}. The summary must solely include information related to that topic. 
      Also return a list of third-party quotes that are related to the following topic: ${mix.topic}.
      Also return a list of the three most pertinent facts that are related to the following topic: ${mix.topic}.
      The return format must be stringified JSON in the following format: {
        summary: the detailed summary goes here, or "unrelated" goes here if none of the info is related to the topic: ${mix.topic},
        quotes: {
          speaker: the identity of the speaker goes here,
          quote: the speaker's quote goes here
        },
        facts: array of the three pertinent facts goes here
      }
      
      Info:
      ${info}"""
      `

      /*
       * Check prompt tokens
       */
      console.log('prompt', prompt);
      promises.push(chatJSON(mix, i, prompt));
      
    } else {

    }
  }

  const results = await Promise.all(promises);
  console.log('results', results);
  
  return;
}

const processMix = async (mix, socket) => {
  
  socket.emit('msg', {status: 'success', msg: 'Received contents'});

  await extractText(mix);

  socket.emit('msg', {status: 'success', msg: 'Extracted text'});

  await extractSummaries(mix);

  // get summaries

    // with quotes?

    // with essential facts stated by the author of the article

  socket.emit('text', mix.content);

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
