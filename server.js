import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fileUpload from "express-fileupload";
import fetch from "node-fetch";

// Load environment variables
dotenv.config();

const app = express();

// ✅ WEB APP CONFIG
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(fileUpload({
  limits: { fileSize: 50 * 1024 * 1024 },
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve static files
app.use(express.static(__dirname));

// ✅ SIMPLIFIED VIDEO GENERATION
app.post("/generate-video", async (req, res) => {
  try {
    const { prompt, model = "sora-2025-05-02" } = req.body;
    
    if (!prompt) {
      return res.json({
        success: false,
        error: "Please provide a video prompt"
      });
    }

    console.log(`🎥 Video generation request: "${prompt}"`);

    // Validate configuration
    if (!process.env.AZURE_VIDEO_ENDPOINT || !process.env.AZURE_VIDEO_KEY) {
      return res.json({ 
        success: false,
        error: "Video service configuration missing" 
      });
    }

    const baseEndpoint = process.env.AZURE_VIDEO_ENDPOINT.replace(/\/$/, '');
    const apiVersion = process.env.AZURE_VIDEO_API_VERSION || 'preview';
    const videoEndpoint = `${baseEndpoint}/openai/v1/video/generations/jobs?api-version=${apiVersion}`;

    const requestBody = {
      model: model,
      prompt: prompt,
      height: "720",
      width: "1280",
      n_seconds: "5",
      n_variants: "1"
    };

    console.log(`🔧 Sending to video AI service...`);

    const response = await fetch(videoEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Api-key": process.env.AZURE_VIDEO_KEY,
      },
      body: JSON.stringify(requestBody),
    });

    const responseData = await response.json();

    if (response.status === 201 || response.status === 202) {
      const jobId = responseData.id;
      
      res.json({
        success: true,
        jobId: jobId,
        status: responseData.status,
        message: "Video generation started successfully!",
        note: "Video will be ready in 2-5 minutes."
      });

    } else {
      throw new Error(`Video service error: ${response.status} - ${JSON.stringify(responseData)}`);
    }

  } catch (error) {
    console.error("❌ Video generation error:", error);
    res.json({ 
      success: false,
      error: "Video generation failed: " + error.message 
    });
  }
});

// ✅ IMPROVED VIDEO STATUS CHECK WITH DIRECT URL
app.post("/check-video-status", async (req, res) => {
  try {
    const { jobId } = req.body;
    if (!jobId) {
      return res.json({ success: false, error: "Job ID is required" });
    }

    const status = await checkVideoStatus(jobId);
    
    if (status.success) {
      let videoUrl = null;
      
      // If video is ready, get the direct video URL
      if (status.status === 'succeeded' && status.generations && status.generations.length > 0) {
        videoUrl = await getDirectVideoUrl(jobId, status.generations[0].id);
      }
      
      res.json({
        success: true,
        jobId: jobId,
        status: status.status,
        progress: getProgressFromStatus(status.status),
        videoUrl: videoUrl,
        videoReady: !!videoUrl,
        message: getStatusMessage(status.status, !!videoUrl)
      });
    } else {
      res.json({
        success: false,
        error: status.error
      });
    }
  } catch (error) {
    console.error("❌ Status check error:", error);
    res.json({
      success: false,
      error: "Status check failed: " + error.message
    });
  }
});

// ✅ GET DIRECT VIDEO URL (NO DOWNLOAD NEEDED)
async function getDirectVideoUrl(jobId, generationId) {
  try {
    const baseEndpoint = process.env.AZURE_VIDEO_ENDPOINT.replace(/\/$/, '');
    const apiVersion = process.env.AZURE_VIDEO_API_VERSION || 'preview';
    
    // Get the video data which should include a URL
    const statusEndpoint = `${baseEndpoint}/openai/v1/video/generations/jobs/${jobId}?api-version=${apiVersion}`;
    
    const response = await fetch(statusEndpoint, {
      headers: { "Api-key": process.env.AZURE_VIDEO_KEY },
    });

    if (response.ok) {
      const data = await response.json();
      
      // Try to extract video URL from different possible locations
      if (data.generations && data.generations.length > 0) {
        const generation = data.generations[0];
        
        // Check various possible URL locations
        if (generation.url) {
          console.log(`✅ Found direct video URL: ${generation.url}`);
          return generation.url;
        }
        
        if (generation.data && generation.data.url) {
          console.log(`✅ Found video URL in data: ${generation.data.url}`);
          return generation.data.url;
        }
        
        // If no URL found, construct a direct download URL
        const directUrl = `${baseEndpoint}/openai/v1/video/generations/${generationId}/content?api-version=${apiVersion}`;
        console.log(`🔗 Using constructed URL: ${directUrl}`);
        return directUrl;
      }
    }
    
    return null;
  } catch (error) {
    console.error(`❌ URL extraction error: ${error.message}`);
    return null;
  }
}

// ✅ CHECK VIDEO STATUS FUNCTION
async function checkVideoStatus(jobId) {
  try {
    const baseEndpoint = process.env.AZURE_VIDEO_ENDPOINT.replace(/\/$/, '');
    const apiVersion = process.env.AZURE_VIDEO_API_VERSION || 'preview';
    const statusEndpoint = `${baseEndpoint}/openai/v1/video/generations/jobs/${jobId}?api-version=${apiVersion}`;

    const response = await fetch(statusEndpoint, {
      headers: { "Api-key": process.env.AZURE_VIDEO_KEY },
    });

    if (!response.ok) {
      throw new Error(`Status check failed: ${response.status}`);
    }

    const data = await response.json();
    
    return {
      success: true,
      status: data.status,
      generations: data.generations,
      prompt: data.prompt
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// ✅ PROXY ENDPOINT FOR VIDEO STREAMING (if needed)
app.get("/proxy-video", async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: "URL parameter required" });
    }

    const response = await fetch(url, {
      headers: {
        "Api-key": process.env.AZURE_VIDEO_KEY,
      },
    });

    if (!response.ok) {
      throw new Error(`Proxy fetch failed: ${response.status}`);
    }

    // Set appropriate headers for video streaming
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    
    // Pipe the video stream to response
    response.body.pipe(res);
    
  } catch (error) {
    console.error("❌ Video proxy error:", error);
    res.status(500).json({ error: "Video streaming failed" });
  }
});

// ✅ HEALTH CHECK ENDPOINT
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    video_generation: "enabled", 
    message: "AI Video Generator - Production Ready",
    timestamp: new Date().toISOString()
  });
});

// ✅ ROOT ENDPOINT
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Helper functions
function getProgressFromStatus(status) {
  const progress = {
    'preprocessing': 20,
    'queued': 30, 
    'running': 60,
    'processing': 85,
    'succeeded': 100,
    'failed': 0
  };
  return progress[status] || 10;
}

function getStatusMessage(status, videoReady = false) {
  const messages = {
    'preprocessing': 'Video is being prepared...',
    'queued': 'Video is in queue...',
    'running': 'Video is being generated...',
    'processing': 'Video is processing...',
    'succeeded': videoReady ? 'Video ready!' : 'Finalizing video...',
    'failed': 'Video generation failed'
  };
  return messages[status] || `Status: ${status}`;
}

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 AI VIDEO GENERATOR - PRODUCTION`);
  console.log(`📍 Server running on port: ${port}`);
  console.log(`🎥 Video Generation: ✅ Enabled`);
  console.log(`🔗 Health Check: http://localhost:${port}/health`);
});
