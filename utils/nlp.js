const winkNLP = require( 'wink-nlp' );
const its = require( 'wink-nlp/src/its.js' );
const model = require( 'wink-eng-lite-web-model' );
const nlp = winkNLP( model );
const {encode, decode} = require('gpt-3-encoder')

exports.getSentences  = (text) => { 
    const doc = nlp.readDoc( text );
    const sentences = doc.sentences().out();
    return sentences;
}

exports.numGpt3Tokens = text => {
    const encoded = encode(text);

    return encoded.length;
} 


const test = () => {
    let tokens = exports.numGpt3Tokens('Hello Werld');
    console.log('tokens', tokens);
}

test();