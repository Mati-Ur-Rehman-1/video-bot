import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fileUpload from "express-fileupload";
import fetch from "node-fetch";
import fs from "fs/promises";
import { existsSync, mkdirSync } from "fs";

// Load environment variables
dotenv.config();

const app = express();

// ✅ AZURE WEB APP COMPATIBLE CONFIG
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(fileUpload({
  limits: { fileSize: 50 * 1024 * 1024 },
  useTempFiles: true,
  tempFileDir: '/tmp/'
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ AZURE-COMPATIBLE PATHS
const videosDir = path.join(process.env.HOME || __dirname, 'site', 'wwwroot', 'videos');
if (!existsSync(videosDir)) {
  mkdirSync(videosDir, { recursive: true });
  console.log("✅ Created videos directory for Azure deployment");
}

// Serve static files
app.use(express.static(__dirname));
app.use('/videos', express.static(videosDir));

// ✅ ENHANCED VIDEO GENERATION FOR DEPLOYMENT
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
        error: "Azure Video configuration missing" 
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

    console.log(`🔧 Sending to Azure Sora: ${videoEndpoint}`);

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
      
      // Start background processing
      processVideoInBackground(jobId, prompt);
      
      res.json({
        success: true,
        jobId: jobId,
        status: responseData.status,
        message: "Video generation started successfully!",
        note: "Video will be ready in 2-5 minutes. Please check status periodically."
      });

    } else {
      throw new Error(`Azure API error: ${response.status} - ${JSON.stringify(responseData)}`);
    }

  } catch (error) {
    console.error("❌ Video generation error:", error);
    res.json({ 
      success: false,
      error: "Video generation failed: " + error.message 
    });
  }
});

// ✅ BACKGROUND PROCESSING FOR DEPLOYMENT
async function processVideoInBackground(jobId, prompt) {
  try {
    console.log(`🔄 Background processing started: ${jobId}`);
    
    const videoResult = await waitForVideoCompletion(jobId);
    
    if (videoResult.success) {
      console.log(`✅ Video ready for download: ${jobId}`);
      await downloadAndSaveVideo(jobId, videoResult.generationId);
    } else {
      console.log(`❌ Video processing failed: ${jobId}`, videoResult.error);
    }
  } catch (error) {
    console.error(`❌ Background processing error: ${error.message}`);
  }
}

// ✅ WAIT FOR VIDEO COMPLETION
async function waitForVideoCompletion(jobId) {
  console.log(`⏳ Waiting for video completion: ${jobId}`);
  
  const maxAttempts = 60; // 10 minutes
  const checkInterval = 10000; // 10 seconds
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`🔍 Status check ${attempt}/${maxAttempts}: ${jobId}`);
      
      const status = await checkVideoStatus(jobId);
      
      if (status.success) {
        if (status.status === 'succeeded') {
          console.log(`✅ Video completed successfully: ${jobId}`);
          return {
            success: true,
            status: status.status,
            generationId: status.generationId
          };
        } else if (status.status === 'failed') {
          return {
            success: false,
            error: 'Video generation failed'
          };
        }
      }
      
      // Wait before next check
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      
    } catch (error) {
      console.log(`❌ Status check ${attempt} failed: ${error.message}`);
    }
  }
  
  return {
    success: false,
    error: 'Video generation timeout after 10 minutes'
  };
}

// ✅ DOWNLOAD AND SAVE VIDEO
async function downloadAndSaveVideo(jobId, generationId) {
  try {
    console.log(`📥 Downloading video: ${jobId}`);
    
    const baseEndpoint = process.env.AZURE_VIDEO_ENDPOINT.replace(/\/$/, '');
    const apiVersion = process.env.AZURE_VIDEO_API_VERSION || 'preview';
    
    const endpoints = [
      `${baseEndpoint}/openai/v1/video/generations/${generationId}/content?api-version=${apiVersion}`,
      `${baseEndpoint}/openai/v1/video/generations/jobs/${jobId}/generations/${generationId}/content?api-version=${apiVersion}`,
    ];

    let videoBuffer = null;

    for (const endpoint of endpoints) {
      try {
        console.log(`🔗 Trying download endpoint: ${endpoint}`);
        const response = await fetch(endpoint, {
          headers: { "Api-key": process.env.AZURE_VIDEO_KEY },
        });

        if (response.ok) {
          videoBuffer = await response.buffer();
          console.log(`✅ Download successful from: ${endpoint}`);
          console.log(`📦 Video size: ${(videoBuffer.length / (1024 * 1024)).toFixed(2)} MB`);
          break;
        } else {
          console.log(`❌ Endpoint failed with status: ${response.status}`);
        }
      } catch (error) {
        console.log(`❌ Download endpoint error: ${error.message}`);
        continue;
      }
    }

    if (!videoBuffer) {
      console.log(`❌ All download methods failed for: ${jobId}`);
      return;
    }

    // Save to Azure-compatible storage
    await saveVideoToStorage(jobId, videoBuffer);

  } catch (error) {
    console.error(`❌ Download error for ${jobId}:`, error);
  }
}

// ✅ SAVE VIDEO TO STORAGE
async function saveVideoToStorage(jobId, videoBuffer) {
  try {
    const fileName = `video-${jobId}.mp4`;
    const filePath = path.join(videosDir, fileName);
    
    await fs.writeFile(filePath, videoBuffer);
    console.log(`✅ Video saved to storage: ${fileName}`);
    
  } catch (error) {
    console.error(`❌ Video save error: ${error.message}`);
  }
}

// ✅ CHECK VIDEO STATUS ENDPOINT
app.post("/check-video-status", async (req, res) => {
  try {
    const { jobId } = req.body;
    if (!jobId) {
      return res.json({ success: false, error: "Job ID is required" });
    }

    const status = await checkVideoStatus(jobId);
    
    if (status.success) {
      // Check if video file exists
      const videoPath = path.join(videosDir, `video-${jobId}.mp4`);
      const downloadUrl = existsSync(videoPath) ? `/videos/video-${jobId}.mp4` : null;
      
      res.json({
        success: true,
        jobId: jobId,
        status: status.status,
        progress: getProgressFromStatus(status.status),
        downloadUrl: downloadUrl,
        videoReady: !!downloadUrl,
        generationId: status.generationId,
        message: getStatusMessage(status.status, !!downloadUrl)
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
      throw new Error(`Status check failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    return {
      success: true,
      status: data.status,
      generationId: data.generations?.[0]?.id,
      prompt: data.prompt,
      createdAt: data.created_at,
      finishedAt: data.finished_at
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
  const isAzure = !!process.env.WEBSITE_SITE_NAME;
  
  res.json({
    status: "healthy",
    deployment: isAzure ? "azure-webapp" : "local",
    video_generation: "enabled",
    storage: "local-filesystem",
    region: isAzure ? "azure" : "local",
    message: "AI Video Bot - Production Ready",
    timestamp: new Date().toISOString()
  });
});

// ✅ CHAT ENDPOINT (Optional)
app.post("/chat", async (req, res) => {
  try {
    if (!process.env.AZURE_OPENAI_ENDPOINT || !process.env.AZURE_OPENAI_API_KEY) {
      return res.json({
        reply: "Chat feature is not configured. Please check your environment variables."
      });
    }

    const response = await fetch(`${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=2024-02-01`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": process.env.AZURE_OPENAI_API_KEY,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: req.body.message }],
        max_tokens: 500,
      }),
    });
    
    const data = await response.json();
    res.json({
      reply: data.choices?.[0]?.message?.content || "I couldn't generate a response. Please try again."
    });
  } catch (error) {
    res.status(500).json({ 
      reply: "Chat service is currently unavailable. Please try again later." 
    });
  }
});

// ✅ ROOT ENDPOINT
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ✅ 404 HANDLER
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found"
  });
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
    'succeeded': videoReady ? 'Video ready for download!' : 'Video generated, preparing download...',
    'failed': 'Video generation failed'
  };
  return messages[status] || `Status: ${status}`;
}

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 AI VIDEO BOT - PRODUCTION DEPLOYMENT`);
  console.log(`📍 Server running on port: ${port}`);
  console.log(`🌍 Environment: ${process.env.WEBSITE_SITE_NAME ? 'Azure Web App' : 'Local'}`);
  console.log(`🎥 Video Generation: ✅ Enabled`);
  console.log(`💾 Storage: Local Filesystem`);
  console.log(`🔗 Health Check: http://localhost:${port}/health`);
});
