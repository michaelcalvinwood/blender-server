const axios = require('axios');

exports.getJWT = async (username, password) => {
    
    let request = {
        url: `https://delta.pymnts.com/wp-json/jwt-auth/v1/token`,
        method: "POST",
        withCredentials: false,
        headers: {
            'Content-Type': 'application/json',
            'Accept': "*/*"
        },
        data: {
            username,
            password
        }
    }

    let response;
    try {
        response = await axios(request);
    } catch (err) {
        console.error(err);
        return false;
    }

    return response.data;
}