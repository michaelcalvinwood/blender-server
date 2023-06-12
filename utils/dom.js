const cheerio = require('cheerio');

exports.isHeading = ($, element) => {
    //console.log('isHeading element', element)
    const tagname = $(element)[0].tagName;
    console.log('isHeading', tagname);
    if (tagname === 'h1') return true;
    if (tagname === 'h2') return true;
    if (tagname === 'h3') return true;
    if (tagname === 'h4') return true;
    if (tagname === 'h5') return true;
    if (tagname === 'h6') return true;
    
    return false;
}

exports.removeSectionByHeading = ($, headingElement) => {
    console.log('headingElement', $(headingElement).name, $(headingElement)[0].tagName, $(headingElement).get(0).tagName, $(headingElement).text())
    const removals = [];
    let sibling = $(headingElement)[0].nextSibling;
    console.log('removeSectionByHeading orig sibling', $(sibling)[0].tagName);
    
    while (sibling && !exports.isHeading($, sibling)) {
        //console.log('removeSectionByHeading sibling', $(sibling)[0].tagName, $(sibling).html());
        removals.push(sibling);
        sibling = $(sibling)[0].nextSibling
    }

    for (let i = 0; i < removals.length; ++i) {
        console.log('REMOVING: ', $(removals[i]).name);
        $(removals[i]).remove();
    }
}

exports.downgradeHeadings = $ => {
    for (let i = 5; i >= 0; --i) {
        let headings = $(`h${i}`);
        $(headings).each((index, element) => {
            console.log('downgradeHeadings before', $(element)[0].tagName, $(element).html())
            //$(element).replaceWith = `<h${i+1}>${$(element).text()}</h${i+1}>`
            $(element).replaceWith = `<h${i+1}>hello</h${i+1}>`
            console.log('downgradeHeadings after', $(element)[0].tagName, $(element).html())
        });
    }

    return $;
}