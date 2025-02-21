const readline = require('readline');
const Backup = require('./backup');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const TOKEN_ENV_VAR = 'MS_TEAMS_CHAT_AUTH_TOKEN';
const TOKEN_FILE = path.join(__dirname, '.token'); // Store token in a hidden file

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question) {
  return new Promise((resolve, reject) => {
    rl.question(`${question} `, answer => {
      const value = answer.trim();
      if (value === '') return reject(new Error('missing value'));
      return resolve(answer);
    });
  });
}

function getStoredToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch (error) {
    return null;
  }
}

function setStoredToken(token) {
  try {
    fs.writeFileSync(TOKEN_FILE, token, 'utf8');
  } catch (error) {
    console.warn('Failed to store token:', error.message);
  }
}

function clearStoredToken() {
  try {
    fs.unlinkSync(TOKEN_FILE);
  } catch (error) {
    // Ignore if file doesn't exist
    if (error.code !== 'ENOENT') {
      console.warn('Failed to clear token:', error.message);
    }
  }
}

function downloadEmoticons() {
  return new Promise((resolve, reject) => {
    const dlScript = path.join(__dirname, 'dl-emoticons.js');
    const child = spawn('node', [dlScript], {
      stdio: 'inherit'
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Emoticons download failed with code ${code}`));
      }
    });
  });
}

async function getAuthToken() {
  const storedToken = getStoredToken();
  if (storedToken) {
    console.log('Using stored authentication token');
    return storedToken;
  }
  const token = await ask('Enter JWT:');
  setStoredToken(token);
  return token;
}

async function main() {
  try {
    console.log('Downloading emoticons first...');
    await downloadEmoticons();
    
    const chatId = await ask('Enter chat ID:');
    const target = await ask('Enter target directory name:');

    let backup;
    try {
      const authToken = await getAuthToken();
      backup = new Backup({
        chatId,
        authToken,
        target: `out/${target}`
      });

      await backup.run();
    } catch (error) {
      if (error.message.includes('unauthorized') || error.message.includes('invalid token')) {
        console.log('Token invalid or expired. Clearing stored token...');
        clearStoredToken();
        // Retry once with a new token
        const newAuthToken = await ask('Enter new JWT:');
        setStoredToken(newAuthToken);
        
        backup = new Backup({
          chatId,
          authToken: newAuthToken,
          target: `out/${target}`
        });
        
        await backup.run();
      } else {
        throw error; // Re-throw if it's not a token-related error
      }
    }
  } catch (error) {
    console.error('Error:', error.message);
    throw error;
  }
}

main()
  .then(() => rl.close())
  .catch(err => {
    rl.close();
    console.error(err);
  });