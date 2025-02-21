const fs = require('fs');
const path = require('path');
const util = require('util');
const axios = require('axios');
const config = require('./config.json');

function getMetadataFilePath(config) {
    return path.join(__dirname, '..', config.output.directory, config.output.metadataFile);
}

const metadataFilePath = getMetadataFilePath(config);
const emoticonData = require(metadataFilePath);

// New: function to compute emoticon file path
function getEmoticonFilePath(id, etag, config) {
    const fileName = `${id}_${etag}.png`;
    return path.join(__dirname, '..', config.output.directory, fileName);
}

const fsAPI = {
  writeFile: util.promisify(fs.writeFile),
  open: util.promisify(fs.open),
  write: util.promisify(fs.write),
  close: util.promisify(fs.close),
  readdir: util.promisify(fs.readdir),
  readFile: util.promisify(fs.readFile)
};

const FILENAME_MATCH = /messages-([0-9]{1,})\.json/;
const UPLOADED_IMAGE_MATCH = /https:\/\/graph.microsoft.com\/v1.0\/chats([^"]*)/g;

class Backup {
  constructor ({ chatId, authToken, target }) {
    this.target = target;
    this.chatId = chatId;
    this.instance = axios.create({
      headers: {
        Accept: 'application/json, text/plain, */*',
        Authorization: `Bearer ${authToken}`,
        'Sec-Fetch-Mode': 'cors',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/77.0.3865.120 Safari/537.36'
      }
    });
  }

  async run () {
    await this.createTarget();
    await this.getMessages();
    await this.getImages();
    await this.createHtml();
  }

  createTarget (location) {
    return new Promise((resolve, reject) => {
      function probe (location, callback) {
        fs.access(location, err => {
          if (err) {
            // then try its parent
            probe(path.dirname(location), err => {
              if (err) return callback(err);

              // now create it
              fs.mkdir(location, callback);
            });
          } else {
            callback();
          }
        });
      }

      probe(path.resolve(this.target), resolve);
    });
  }

  async getMessages () {
    // Updated URL to use new endpoint
    let url = `https://graph.microsoft.com/v1.0/chats/${this.chatId}/messages`;
    let page = 0;

    while (true) {
      const pageNum = `0000${page++}`.slice(-5);

      console.log(`retrieve page ${pageNum}`);
      const res = await this.instance.get(url);

      if (res.data.value && res.data.value.length) {
        await fsAPI.writeFile(
          path.resolve(this.target, `messages-${pageNum}.json`),
          JSON.stringify(res.data.value, null, '  '),
          'utf8');
      }

      // if there's a next page (earlier messages) ...
      if (res.data['@odata.count'] && res.data['@odata.nextLink']) {
        // .. get these in the next round
        url = res.data['@odata.nextLink'];
      } else {
        // otherwise we're done
        break;
      }
    }
  }

  async getPages () {
    const filenames = await fsAPI.readdir(this.target);
    return filenames.filter(filename => FILENAME_MATCH.test(filename));
  }

  async getImages () {
    const pages = await this.getPages();

    const index = {};
    let imageIdx = 0;

    // loop over pages
    for (const page of pages) {
      const data = await fsAPI.readFile(path.resolve(this.target, page), 'utf8');
      const messages = JSON.parse(data);

      // loop over messages
      for (const message of messages) {
        if (message.body.contentType === 'html') {
          // detect image
          const imageUrls = message.body.content.match(UPLOADED_IMAGE_MATCH);
          if (imageUrls) {
            for (const imageUrl of imageUrls) {
              if (!index[imageUrl]) {
                const targetFilename = 'image-' + `0000${imageIdx++}`.slice(-5);

                console.log('downloading', targetFilename);

                const res = await this.instance({
                  method: 'get',
                  url: imageUrl,
                  responseType: 'stream'
                });

                res.data.pipe(fs.createWriteStream(path.resolve(this.target, targetFilename)));
                await pipeDone(res.data);

                index[imageUrl] = targetFilename;
              }
            }
          }
        }
      }
    }

    // write image index
    await fsAPI.writeFile(path.resolve(this.target, 'images.json'), JSON.stringify(index), 'utf8');
  }

  async createHtml () {
    // need my id to identify 'my' messages
    const profile = await this.instance.get('https://graph.microsoft.com/v1.0/me/');
    const myId = profile.data.id;

    // collect pages to include
    const pages = await this.getPages();

    // get image mappings
    let imageIndex;
    try {
      const imageIndexData = await fsAPI.readFile(path.resolve(this.target, 'images.json'), 'utf8');
      imageIndex = JSON.parse(imageIndexData);
    } catch (er) {
      console.error('couldn\'t read images index', er);
      // continue without images
    }

    const fd = await fsAPI.open(path.resolve(this.target, 'index.html'), 'w');

    // write head
    await fsAPI.write(fd, `<html>
  <head>
    <meta charset="UTF-8">
    <link rel="stylesheet" href="../../messages.css">
  </head>
  <body>
`);

    // Merge all messages from all pages into a single array
    let allMessages = [];
    for (const page of pages) {
      const data = await fsAPI.readFile(path.resolve(this.target, page), 'utf8');
      const messages = JSON.parse(data);
      allMessages = allMessages.concat(messages);
    }
    // Sort the combined messages by createdDateTime (ascending)
    allMessages.sort((a, b) => new Date(a.createdDateTime) - new Date(b.createdDateTime));

    // Introduce variables (prevSender and prevTime) before looping over messages.
    let prevSender = null;
    let prevTime = null;
    let prevHadReaction = false;  // New flag
    // Introduce variable for previous day tracking
    let lastMessageDay = null;

    // Loop over the sorted messages:
    for (const message of allMessages) {
      // Obtain current message time
      const currentTime = new Date(message.createdDateTime || message.lastModifiedDateTime);
      // NEW: Insert date separator if day has changed.
      const messageDayString = currentTime.toDateString();
      // Compute today and yesterday strings.
      const today = new Date();
      const todayString = today.toDateString();
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      const yesterdayString = yesterday.toDateString();
      let dayLabel;
      if (messageDayString === todayString) {
        dayLabel = "Today";
      } else if (messageDayString === yesterdayString) {
        dayLabel = "Yesterday";
      } else {
        dayLabel = currentTime.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      }
      if (lastMessageDay !== messageDayString) {
        await fsAPI.write(fd, `<div class="message-header" style="text-align: center;">${dayLabel}</div>`);
        lastMessageDay = messageDayString;
      }
      
      // Determine sender identifier: for user use user.id; for application use displayName.
      let senderId = null;
      if (message.from) {
        if (message.from.user) {
          senderId = message.from.user.id;
        } else if (message.from.application) {
          senderId = message.from.application.displayName;
        }
      }
      // Determine if header should be shown (if same sender within 60 seconds then skip)
      let showHeader = true;
      if (prevSender && prevTime && senderId === prevSender && (currentTime - prevTime) <= 60000) {
        showHeader = false;
      }
      
      const thisMessageHadReaction = (message.reactions && message.reactions.length > 0);
      
      // Render message depending on whether header is to be shown
      if (message.from) {
        if (message.from.user != null) {
          // Render message group with optional inline style for reduced spacing if header is skipped:
          if (showHeader) {
            await fsAPI.write(fd, `<div class="message-group ${message.from.user.id === myId ? 'group-right' : 'group-left'}">`);
            await fsAPI.write(fd, `<div class="message-header">
      ${message.from.user.displayName} - <span class="timestamp">${message.createdDateTime || message.lastModifiedDateTime}</span>${message.lastEditedDateTime ? ' <span class="edited-label">&nbsp;Edited</span>' : ''}
    </div>`);
          } else {
            // Use normal group class if previous bubble had reaction; else, collapsed style.
            const groupClass = (prevHadReaction) ? 
               (message.from.user.id === myId ? 'group-right' : 'group-left') :
               (message.from.user.id === myId ? 'group-right-collapsed' : 'group-left-collapsed');
            await fsAPI.write(fd, `<div class="message-group ${groupClass}">`);
          }
          await fsAPI.write(fd, `<div class="message ${message.from.user.id === myId ? 'message-right' : 'message-left'}">`);
          if (message.attachments && message.attachments.length > 0) {
            await fsAPI.write(fd, `<div class="attachment-container">`);
            for (const att of message.attachments) {
              try {
                if (!att.content) {
                  console.error("Attachment content is null or empty; skipping attachment.");
                  continue;
                }
                const attObj = JSON.parse(att.content);
                if (!attObj) {
                  console.error("Attachment parsed object is null; skipping.");
                  continue;
                }
                let attachmentTimestamp = message.createdDateTime || message.lastModifiedDateTime;
                if (attObj.messageId) {
                  // Find the corresponding message in allMessages using attObj.messageId
                  for (const m of allMessages) {
                    if (m.id === attObj.messageId) {
                      attachmentTimestamp = m.createdDateTime || m.lastModifiedDateTime;
                      break;
                    }
                  }
                }
                await fsAPI.write(fd, `<div class="attachment">
      <div class="attachment-header">${attObj.messageSender && attObj.messageSender.user ? attObj.messageSender.user.displayName : 'Unknown'} - ${attachmentTimestamp}</div>
      <div class="message-body">
        ${attObj.messagePreview}
      </div>
    </div>`);
              } catch (e) {
                console.error("Attachment parse error:", e);
              }
            }
            await fsAPI.write(fd, `</div>`);
          }
          
          // Render reaction images if present:
          if (message.reactions && message.reactions.length > 0) {
            // For a left message, reaction container is 'reaction-left'; for right messages use 'reaction-right'
            const reactionPosition = (message.from.user.id === myId) ? 'reaction-right' : 'reaction-left';
            await fsAPI.write(fd, `<div class="${reactionPosition}">`);
            for (const reaction of message.reactions) {
              let shortcut;
              if (reaction.displayName.toLowerCase() === 'like') {
                shortcut = '(yes)';
              } else {
                shortcut = `(${reaction.displayName.toLowerCase()})`;
              }
              let foundEmoticon;
              for (const cat of emoticonData.categories) {
                foundEmoticon = cat.emoticons.find(e => 
                  e.shortcuts.some(s => s.toLowerCase() === shortcut)
                );
                if (foundEmoticon) break;
              }
              if (foundEmoticon) {
                const emoticonPath = getEmoticonFilePath(foundEmoticon.id, foundEmoticon.etag, config);
                // Embed in a div with reaction-oval styling
                await fsAPI.write(fd, `<div class="reaction-oval"><img src="${emoticonPath}" class="scaled-image" alt="${shortcut}"></div>`);
              } else {
                console.error("Reaction emoticon not found for shortcut:", shortcut, "in", reactionPosition, "bubble");
              }
            }
            await fsAPI.write(fd, `</div>`);
          }

          await fsAPI.write(fd, `<div class="message-body">${message.body.contentType === 'html' ? replaceImages(message.body.content, imageIndex) : escapeHtml(message.body.content)}</div>
    </div>
    </div>`);
        } else if (message.from.application != null) {
          // Render message group with optional inline style for reduced spacing if header is skipped:
          if (showHeader) {
            await fsAPI.write(fd, `<div class="message-group group-left">`);
            await fsAPI.write(fd, `<div class="message-header">
      ${message.from.application.displayName} - <span class="timestamp">${message.createdDateTime || message.lastModifiedDateTime}</span>${message.lastEditedDateTime ? ' <span class="edited-label">&nbsp;Edited</span>' : ''}
    </div>`);
          } else {
            const groupClass = (prevHadReaction) ? "group-left" : "group-left-collapsed";
            await fsAPI.write(fd, `<div class="message-group ${groupClass}">`);
          }
          await fsAPI.write(fd, `<div class="message message-left">`);
          if (message.attachments && message.attachments.length > 0) {
            for (const att of message.attachments) {
              try {
                if (!att.content) {
                  console.error("Attachment content is null or empty; skipping attachment.");
                  continue;
                }
                const attObj = JSON.parse(att.content);
                if (!attObj) {
                  console.error("Attachment parsed object is null; skipping.");
                  continue;
                }
                let attachmentTimestamp = message.createdDateTime || message.lastModifiedDateTime;
                if (attObj.messageId) {
                  for (const m of allMessages) {
                    if (m.id === attObj.messageId) {
                      attachmentTimestamp = m.createdDateTime || m.lastModifiedDateTime;
                      break;
                    }
                  }
                }
                await fsAPI.write(fd, `<div class="attachment">
      <div class="attachment-header">${attObj.messageSender && attObj.messageSender.user ? attObj.messageSender.user.displayName : 'Unknown'} - ${attachmentTimestamp}</div>
      <div class="message-body">
        ${attObj.messagePreview}
      </div>
    </div>`);
              } catch (e) {
                console.error("Attachment parse error:", e);
              }
            }
          }
          // Render reaction images if present:
          if (message.reactions && message.reactions.length > 0) {
            // For a left message, reaction container is 'reaction-left'; for right messages use 'reaction-right'
            const reactionPosition = 'reaction-left';
            await fsAPI.write(fd, `<div class="${reactionPosition}">`);
            for (const reaction of message.reactions) {
              let shortcut;
              if (reaction.displayName.toLowerCase() === 'like') {
                shortcut = '(yes)';
              } else {
                shortcut = `(${reaction.displayName.toLowerCase()})`;
              }
              let foundEmoticon;
              for (const cat of emoticonData.categories) {
                foundEmoticon = cat.emoticons.find(e => 
                  e.shortcuts.some(s => s.toLowerCase() === shortcut)
                );
                if (foundEmoticon) break;
              }
              if (foundEmoticon) {
                const emoticonPath = getEmoticonFilePath(foundEmoticon.id, foundEmoticon.etag, config);
                // Embed in a div with reaction-oval styling
                await fsAPI.write(fd, `<div class="reaction-oval"><img src="${emoticonPath}" class="scaled-image" alt="${shortcut}"></div>`);
              } else {
                console.error("Reaction emoticon not found for shortcut:", shortcut, "in", reactionPosition, "bubble");
              }
            }
            await fsAPI.write(fd, `</div>`);
          }
          await fsAPI.write(fd, `</div>`);
        } else {
          console.error('couldn\'t determine message sender');
        }
      }
      // Update previous sender info for next iteration
      prevSender = senderId;
      prevTime = currentTime;
      prevHadReaction = thisMessageHadReaction;
    }

    // write foot
    await fsAPI.write(fd, `<script>
function formatTimestamps() {
  var headers = document.querySelectorAll('.message-header');
  var today = new Date();
  var todayStr = today.toLocaleDateString();
  var currentYear = today.getFullYear();
  var timeOptions = { hour: 'numeric', minute: 'numeric' };
  var dateOptionsWithYear = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' };
  var dateOptionsWithoutYear = { month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' };

  headers.forEach(function(header) {
    var timestampElem = header.querySelector('.timestamp');
    if (timestampElem) {
      var utcString = timestampElem.innerText.trim();
      var date = new Date(utcString);
      if (!isNaN(date.getTime())) {
        var localDateStr = date.toLocaleDateString();
        if (localDateStr === todayStr) {
          timestampElem.innerText = date.toLocaleTimeString(undefined, timeOptions);
        } else {
          var dateOptions = (date.getFullYear() === currentYear) ? dateOptionsWithoutYear : dateOptionsWithYear;
          timestampElem.innerText = date.toLocaleString(undefined, dateOptions);
        }
      }
    } else {
      var parts = header.innerText.split(' - ');
      if (parts.length >= 2) {
        var displayName = parts.slice(0, parts.length - 1).join(' - ');
        var utcString = parts[parts.length - 1].trim();
        var date = new Date(utcString);
        if (!isNaN(date.getTime())) {
          var localDateStr = date.toLocaleDateString();
          if (localDateStr === todayStr) {
            header.innerText = displayName + ' - ' + date.toLocaleTimeString(undefined, timeOptions);
          } else {
            var dateOptions = (date.getFullYear() === currentYear) ? dateOptionsWithoutYear : dateOptionsWithYear;
            header.innerText = displayName + ' - ' + date.toLocaleString(undefined, dateOptions);
          }
        }
      }
    }
  });
}
document.addEventListener('DOMContentLoaded', formatTimestamps);
</script>
</body>
</html>
`);

    await fsAPI.close(fd);
  }
}

function escapeHtml (unsafe) {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;') // fixed the regex here
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function replaceImages (content, imageIndex) {
  if (imageIndex) {
    return content.replace(UPLOADED_IMAGE_MATCH, url => {
      // replace (if we have a replacement)
      return imageIndex[url] || url;
    });
  }

  return content;
}

function pipeDone (readable) {
  return new Promise((resolve, reject) => {
    readable.on('end', resolve);
  });
}

module.exports = Backup;
