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

// Store video data in memory
const videoStore = new Map();

// ✅ SIMPLIFIED VIDEO GENERATION
app.post("/generate-video", async (req, res) => {
  try {
    const { prompt, duration = "5", quality = "720" } = req.body;
    
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

    // Calculate width based on quality
    const width = quality === "1080" ? "1920" : quality === "720" ? "1280" : "854";
    const height = quality === "1080" ? "1080" : quality === "720" ? "720" : "480";

    const requestBody = {
      model: "sora",
      prompt: prompt,
      height: height,
      width: width,
      n_seconds: duration.toString(),
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
      
      // Start monitoring the video generation
      monitorVideoGeneration(jobId);
      
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

// ✅ MONITOR VIDEO GENERATION IN BACKGROUND
async function monitorVideoGeneration(jobId) {
  console.log(`🔄 Starting background monitoring for job: ${jobId}`);
  
  const maxAttempts = 60; // 10 minutes
  const checkInterval = 10000; // 10 seconds
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`🔍 Monitoring attempt ${attempt}/${maxAttempts} for job: ${jobId}`);
      
      const status = await checkVideoStatus(jobId);
      
      if (status.success) {
        if (status.status === 'succeeded') {
          console.log(`✅ Video generation completed: ${jobId}`);
          
          // Store the generation ID for download
          if (status.generations && status.generations.length > 0) {
            const generationId = status.generations[0].id;
            videoStore.set(jobId, {
              generationId: generationId,
              status: 'ready',
              prompt: status.prompt
            });
            console.log(`🎬 Generation ID stored for job ${jobId}: ${generationId}`);
          }
          break;
          
        } else if (status.status === 'failed') {
          console.log(`❌ Video generation failed: ${jobId}`);
          videoStore.set(jobId, { status: 'failed' });
          break;
        }
      }
      
      // Wait before next check
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      
    } catch (error) {
      console.log(`⚠️ Monitoring attempt ${attempt} failed: ${error.message}`);
    }
  }
}

// ✅ IMPROVED VIDEO STATUS CHECK
app.post("/check-video-status", async (req, res) => {
  try {
    const { jobId } = req.body;
    if (!jobId) {
      return res.json({ success: false, error: "Job ID is required" });
    }

    const status = await checkVideoStatus(jobId);
    
    if (status.success) {
      // Check if we have a stored video data
      const videoData = videoStore.get(jobId);
      const videoReady = videoData && videoData.status === 'ready';
      
      res.json({
        success: true,
        jobId: jobId,
        status: status.status,
        progress: getProgressFromStatus(status.status),
        videoReady: videoReady,
        message: getStatusMessage(status.status, videoReady)
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

// ✅ DOWNLOAD VIDEO ENDPOINT - FIXED!
app.get("/download-video", async (req, res) => {
  try {
    const { jobId } = req.query;
    
    if (!jobId) {
      return res.status(400).json({ error: "Job ID is required" });
    }

    console.log(`📥 Download request for job: ${jobId}`);

    // Get video data from store
    const videoData = videoStore.get(jobId);
    
    if (!videoData || videoData.status !== 'ready') {
      return res.status(404).json({ error: "Video not ready or not found" });
    }

    const baseEndpoint = process.env.AZURE_VIDEO_ENDPOINT.replace(/\/$/, '');
    const apiVersion = process.env.AZURE_VIDEO_API_VERSION || 'preview';
    
    // Use the correct download endpoint from your Python code
    const downloadUrl = `${baseEndpoint}/openai/v1/video/generations/${videoData.generationId}/content/video?api-version=${apiVersion}`;
    
    console.log(`🔗 Downloading from: ${downloadUrl}`);

    const response = await fetch(downloadUrl, {
      headers: { 
        "Api-key": process.env.AZURE_VIDEO_KEY,
      },
    });

    if (!response.ok) {
      throw new Error(`Download failed with status: ${response.status}`);
    }

    // Get the video buffer
    const videoBuffer = Buffer.from(await response.arrayBuffer());
    
    // Set download headers
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="ai-video-${jobId}.mp4"`);
    res.setHeader('Content-Length', videoBuffer.length);
    res.setHeader('Cache-Control', 'no-cache');
    
    console.log(`✅ Download successful, sending ${videoBuffer.length} bytes`);
    
    // Send the video
    res.send(videoBuffer);

  } catch (error) {
    console.error("❌ Download error:", error);
    res.status(500).json({ error: "Download failed: " + error.message });
  }
});

// ✅ GET VIDEO INFO ENDPOINT
app.get("/get-video-info", (req, res) => {
  try {
    const { jobId } = req.query;
    
    if (!jobId) {
      return res.status(400).json({ error: "Job ID is required" });
    }

    const videoData = videoStore.get(jobId);
    
    if (!videoData) {
      return res.status(404).json({ error: "Video data not found" });
    }

    res.json({
      success: true,
      jobId: jobId,
      status: videoData.status,
      generationId: videoData.generationId,
      prompt: videoData.prompt
    });
    
  } catch (error) {
    console.error("❌ Get video info error:", error);
    res.status(500).json({ error: "Failed to get video info" });
  }
});

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

// ✅ HEALTH CHECK ENDPOINT
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    video_generation: "enabled", 
    message: "AI Video Generator - Production Ready",
    timestamp: new Date().toISOString(),
    active_jobs: videoStore.size
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
    'succeeded': videoReady ? 'Video ready for download!' : 'Finalizing video...',
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
