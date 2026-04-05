const express = require('express');
const cors = require('cors');
const { GetListByKeyword } = require('youtube-search-api');
const { exec } = require('child_process');
const util = require('util');
const fetch = require('node-fetch');
const execPromise = util.promisify(exec);

const app = express();
const PORT = 3001;

// At the top of server.js, add:
const fs = require('fs');

// Add this function before getStreamUrl:
function setupCookies() {
  if (process.env.YOUTUBE_COOKIES) {
    fs.writeFileSync('./youtube_cookies.txt', process.env.YOUTUBE_COOKIES);
    console.log('✅ Cookies loaded from environment variable');
  }
}

// Call it when server starts (before app.listen):
setupCookies();

app.use(cors());
app.use(express.json());

// Cache for stream URLs (they expire after ~6 hours anyway)
const streamCache = new Map();

// Search for videos
app.get('/api/search', async (req, res) => {
  try {
    const { query } = req.query;
    if (!query) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }

    const results = await GetListByKeyword(query, false, 20);
    
    const videos = results.items
      .filter(item => item.type === 'video')
      .map(video => ({
        id: video.id,
        title: video.title,
        artist: video.channelTitle || 'Unknown',
        duration: formatDuration(video.length?.simpleText),
        thumbnail: video.thumbnail?.thumbnails?.[0]?.url || '',
        url: `https://www.youtube.com/watch?v=${video.id}`
      }));

    res.json(videos);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Failed to search videos' });
  }
});

// Get stream URL (cached)
async function getStreamUrl(videoId) {
  // Check cache first
  if (streamCache.has(videoId)) {
    const cached = streamCache.get(videoId);
    // Check if cache is still valid (valid for 5 hours)
    if (Date.now() - cached.timestamp < 5 * 60 * 60 * 1000) {
      console.log('Using cached stream URL');
      return cached.url;
    } else {
      streamCache.delete(videoId);
    }
  }

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  console.log('Getting fresh stream URL for:', videoId);
  
  // Updated command with better options to avoid rate limiting
  const command = `yt-dlp -f "bestaudio/best" --cookies youtube_cookies.txt --no-check-certificates --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" --extractor-args "youtube:player_client=android" --get-url "${url}"`;
  
  try {
    const { stdout, stderr } = await execPromise(command, {
      timeout: 30000 // 30 second timeout
    });
    
    if (stderr && !stdout) {
      console.error('yt-dlp stderr:', stderr);
      throw new Error('Failed to get stream URL');
    }
    
    const streamUrl = stdout.trim();
    
    if (!streamUrl || streamUrl.includes('ERROR')) {
      throw new Error('Invalid stream URL received');
    }
    
    // Cache the URL
    streamCache.set(videoId, {
      url: streamUrl,
      timestamp: Date.now()
    });
    
    console.log('✅ Stream URL obtained successfully');
    return streamUrl;
  } catch (error) {
    console.error('yt-dlp error:', error);
    throw error;
  }
}

// Proxy the audio stream with Range support
app.get('/api/stream/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    
    if (!videoId || videoId === 'undefined') {
      return res.status(400).json({ error: 'Invalid video ID' });
    }
    
    let streamUrl;
    try {
      streamUrl = await getStreamUrl(videoId);
    } catch (error) {
      console.error('Failed to get stream URL:', error);
      return res.status(500).json({ 
        error: 'Failed to get stream URL. YouTube may be rate limiting. Try again in a few minutes. =>  ' + error 
      });
    }
    
    // Get range header from request
    const range = req.headers.range;
    
    // Build headers for YouTube request
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };
    
    if (range) {
      headers['Range'] = range;
      console.log('Range request:', range);
    }
    
    // Fetch the stream from YouTube with range support
    const response = await fetch(streamUrl, { headers });
    
    if (!response.ok) {
      console.error('YouTube fetch failed:', response.status);
      // If URL expired, try getting a fresh one
      if (response.status === 403 || response.status === 404) {
        console.log('Stream URL expired, getting fresh URL...');
        streamCache.delete(videoId);
        try {
          const newStreamUrl = await getStreamUrl(videoId);
          const retryResponse = await fetch(newStreamUrl, { headers });
          
          if (!retryResponse.ok) {
            return res.status(500).json({ error: 'Failed to fetch audio stream after retry' });
          }
          
          return pipeStream(retryResponse, res, range);
        } catch (retryError) {
          return res.status(500).json({ error: 'Failed to refresh stream URL' });
        }
      }
      return res.status(500).json({ error: 'Failed to fetch audio stream' });
    }
    
    pipeStream(response, res, range);
    
  } catch (error) {
    console.error('Stream error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to get stream: ' + error.message });
    }
  }
});

function pipeStream(response, res, range) {
  // Set status code based on range request
  if (range) {
    res.status(206); // Partial Content
  } else {
    res.status(200);
  }
  
  // Forward important headers
  res.setHeader('Content-Type', response.headers.get('content-type') || 'audio/webm');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-cache');
  
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    res.setHeader('Content-Length', contentLength);
  }
  
  const contentRange = response.headers.get('content-range');
  if (contentRange) {
    res.setHeader('Content-Range', contentRange);
  }
  
  // Pipe the response
  response.body.pipe(res);
  
  response.body.on('error', (error) => {
    console.error('Stream pipe error:', error);
    if (!res.headersSent) {
      res.status(500).end();
    }
  });
}

// Helper function to format duration
function formatDuration(durationText) {
  if (!durationText) return 'N/A';
  return durationText;
}

app.listen(PORT, () => {
  console.log(`🎵 Music server running on http://localhost:${PORT}`);
  console.log('⚠️  Make sure yt-dlp is installed and updated!');
  console.log('   Run: yt-dlp -U (to update)');
  console.log('✅ Range requests enabled for fast seeking');
});
