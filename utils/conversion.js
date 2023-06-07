
var mammoth = require("mammoth");
const cheerio = require ('cheerio');


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