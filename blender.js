const listenPort = 6256;
const hostname = 'blender.pymnts.com'
const privateKeyPath = `/etc/letsencrypt/live/${hostname}/privkey.pem`;
const fullchainPath = `/etc/letsencrypt/live/${hostname}/fullchain.pem`;

const express = require('express');
const https = require('https');
const cors = require('cors');
const fs = require('fs');
const socketio = require('socket.io');

const app = express();
app.use(express.static('public'));
app.use(express.json({limit: '200mb'})); 
app.use(cors());

app.get('/', (req, res) => {
    res.send('Hello, World!');
});


const processMix = async (mix, socket) => {
  console.log('mix', mix);
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


