
var mammoth = require("mammoth");
const cheerio = require ('cheerio');
const pdf = require('pdf-parse');
const fs = require('fs');

exports.convertPdfToText = async fileName => {
    let dataBuffer = fs.readFileSync(fileName);
 
    let data;
    try {
        data = await pdf(dataBuffer);    
        return data.text.replaceAll("-\n", "").replaceAll("\n", " ");
    } catch (err) {
        console.error(err);
        return '';

    }
}

exports.convertDocxToHTML = async fileName => {
    let result;
    try {
        result = await mammoth.convertToHtml({path: fileName})
    } catch (err) {
        console.error(err);
        return '';
    }

    return result.value;
    
}

exports.removeImagesAndTablesFromHTML = html => {
    const $ = cheerio.load(html);
    $('img').remove();
    $('table').remove();

    return $.html();
}