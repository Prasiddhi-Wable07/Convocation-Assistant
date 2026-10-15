const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const config = require('./src/config');
const firebaseService = require('./src/firebaseService');
const { requireAdminAuth, authenticateAdmin } = require('./src/authService');
const { processStudentQuery } = require('./src/aiService');

const app = express();

// Middleware: Security and Body Parsing
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Rate Limiting for Public APIs
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 120, // Limit each IP to 120 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests from this IP, please try again after 15 minutes.'
  }
});
app.use('/api/', generalLimiter);

// Stricter Rate Limiting for Admin Authentication
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: {
    success: false,
    error: 'Too many authentication attempts. Please try again after 15 minutes.'
  }
});
app.use('/api/admin/login', authLimiter);

// Serve Frontend Static Files
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// PUBLIC API ROUTES
// ---------------------------------------------------------------------------

/**
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    database: {
      isLiveFirestore: firebaseService.isConnectedToFirestore(),
      mode: firebaseService.isConnectedToFirestore() ? 'Google Cloud Firestore' : 'Local File Persistence Store'
    },
    aiEngine: {
      provider: 'Google Gemini',
      model: config.gemini.model,
      isApiKeyConfigured: config.gemini.isConfigured
    },
    defaultInstitution: config.defaultInstitutionId
  });
});

/**
 * Safe public configuration for client initialization
 */
app.get('/api/config', async (req, res) => {
  try {
    const institutions = await firebaseService.getInstitutions();
    res.json({
      success: true,
      defaultInstitutionId: config.defaultInstitutionId,
      supportedLanguages: config.supportedLanguages,
      clientFirebase: config.clientFirebase,
      isLiveFirestore: firebaseService.isConnectedToFirestore(),
      isGeminiConfigured: config.gemini.isConfigured,
      institutions: institutions.map(i => ({
        id: i.id,
        name: i.name,
        shortName: i.shortName,
        location: i.location,
        affiliatedUniversity: i.affiliatedUniversity,
        branding: i.branding
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * List all institutions
 */
app.get('/api/institutions', async (req, res) => {
  try {
    const institutions = await firebaseService.getInstitutions();
    res.json({ success: true, data: institutions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Get public convocation details (ONLY published records)
 */
app.get('/api/convocation/public-info', async (req, res) => {
  try {
    const institutionId = req.query.institutionId || config.defaultInstitutionId;
    const context = await firebaseService.getPublishedContext(institutionId);
    
    res.json({
      success: true,
      data: {
        institution: context.institution,
        activeEvent: context.publishedEvents[0] || null,
        recentNotices: context.publishedNotices.slice(0, 5)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Student AI Chat Query Endpoint
 * Runs the complete 10-step AI retrieval pipeline
 */
app.post('/api/chat', async (req, res) => {
  try {
    const { question, language, institutionId, conversationHistory } = req.body;

    if (!question || typeof question !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Question is required and must be a valid string.'
      });
    }

    const selectedInstitutionId = institutionId || config.defaultInstitutionId;
    const selectedLanguage = language || 'en';

    const result = await processStudentQuery({
      question,
      targetLanguage: selectedLanguage,
      institutionId: selectedInstitutionId,
      conversationHistory: conversationHistory || []
    });

    res.json(result);
  } catch (err) {
    console.error('Chat endpoint error:', err);
    res.status(500).json({
      success: false,
      error: 'An internal error occurred while processing your request: ' + err.message
    });
  }
});

// ---------------------------------------------------------------------------
// ADMINISTRATOR API ROUTES (Protected)
// ---------------------------------------------------------------------------

/**
 * Admin Login Endpoint
 */
app.post('/api/admin/login', authenticateAdmin);

/**
 * Dashboard Overview Statistics
 */
app.get('/api/admin/overview', requireAdminAuth, async (req, res) => {
  try {
    const institutionId = req.query.institutionId || config.defaultInstitutionId;
    const overview = await firebaseService.getAdminOverview(institutionId);
    res.json({ success: true, data: overview });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * List Convocation Events (Includes drafts and archived)
 */
app.get('/api/admin/events', requireAdminAuth, async (req, res) => {
  try {
    const institutionId = req.query.institutionId || config.defaultInstitutionId;
    const status = req.query.status || null;
    const events = await firebaseService.getEvents(institutionId, status);
    res.json({ success: true, data: events });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Create Convocation Event
 */
app.post('/api/admin/events', requireAdminAuth, async (req, res) => {
  try {
    const institutionId = req.body.institutionId || config.defaultInstitutionId;
    const adminEmail = req.adminUser.email;
    const created = await firebaseService.createEvent(institutionId, req.body, adminEmail);
    res.status(201).json({ success: true, data: created });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Update Convocation Event
 */
app.put('/api/admin/events/:id', requireAdminAuth, async (req, res) => {
  try {
    const institutionId = req.body.institutionId || config.defaultInstitutionId;
    const eventId = req.params.id;
    const adminEmail = req.adminUser.email;
    const updated = await firebaseService.updateEvent(institutionId, eventId, req.body, adminEmail);
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Publish Convocation Event (Makes it active for AI Agent)
 */
app.post('/api/admin/events/:id/publish', requireAdminAuth, async (req, res) => {
  try {
    const institutionId = req.body.institutionId || config.defaultInstitutionId;
    const eventId = req.params.id;
    const adminEmail = req.adminUser.email;
    const published = await firebaseService.publishEvent(institutionId, eventId, adminEmail);
    res.json({ success: true, message: 'Event successfully published.', data: published });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Archive Convocation Event
 */
app.post('/api/admin/events/:id/archive', requireAdminAuth, async (req, res) => {
  try {
    const institutionId = req.body.institutionId || config.defaultInstitutionId;
    const eventId = req.params.id;
    const adminEmail = req.adminUser.email;
    const archived = await firebaseService.archiveEvent(institutionId, eventId, adminEmail);
    res.json({ success: true, message: 'Event archived.', data: archived });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Delete Convocation Event
 */
app.delete('/api/admin/events/:id', requireAdminAuth, async (req, res) => {
  try {
    const institutionId = req.query.institutionId || config.defaultInstitutionId;
    const eventId = req.params.id;
    const adminEmail = req.adminUser.email;
    const result = await firebaseService.deleteEvent(institutionId, eventId, adminEmail);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * List Notices
 */
app.get('/api/admin/notices', requireAdminAuth, async (req, res) => {
  try {
    const institutionId = req.query.institutionId || config.defaultInstitutionId;
    const status = req.query.status || null;
    const notices = await firebaseService.getNotices(institutionId, status);
    res.json({ success: true, data: notices });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Create Notice
 */
app.post('/api/admin/notices', requireAdminAuth, async (req, res) => {
  try {
    const institutionId = req.body.institutionId || config.defaultInstitutionId;
    const adminEmail = req.adminUser.email;
    const created = await firebaseService.createNotice(institutionId, req.body, adminEmail);
    res.status(201).json({ success: true, data: created });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Update Notice
 */
app.put('/api/admin/notices/:id', requireAdminAuth, async (req, res) => {
  try {
    const institutionId = req.body.institutionId || config.defaultInstitutionId;
    const noticeId = req.params.id;
    const adminEmail = req.adminUser.email;
    const updated = await firebaseService.updateNotice(institutionId, noticeId, req.body, adminEmail);
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Publish Notice
 */
app.post('/api/admin/notices/:id/publish', requireAdminAuth, async (req, res) => {
  try {
    const institutionId = req.body.institutionId || config.defaultInstitutionId;
    const noticeId = req.params.id;
    const adminEmail = req.adminUser.email;
    const published = await firebaseService.publishNotice(institutionId, noticeId, adminEmail);
    res.json({ success: true, message: 'Notice successfully published.', data: published });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Archive Notice
 */
app.post('/api/admin/notices/:id/archive', requireAdminAuth, async (req, res) => {
  try {
    const institutionId = req.body.institutionId || config.defaultInstitutionId;
    const noticeId = req.params.id;
    const adminEmail = req.adminUser.email;
    const archived = await firebaseService.archiveNotice(institutionId, noticeId, adminEmail);
    res.json({ success: true, message: 'Notice archived.', data: archived });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Delete Notice
 */
app.delete('/api/admin/notices/:id', requireAdminAuth, async (req, res) => {
  try {
    const institutionId = req.query.institutionId || config.defaultInstitutionId;
    const noticeId = req.params.id;
    const adminEmail = req.adminUser.email;
    const result = await firebaseService.deleteNotice(institutionId, noticeId, adminEmail);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Update Institution Settings
 */
app.put('/api/admin/institution', requireAdminAuth, async (req, res) => {
  try {
    const adminEmail = req.adminUser.email;
    const updated = await firebaseService.saveInstitution(req.body, adminEmail);
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Serve admin dashboard explicitly on /admin and /admin/*
app.get(['/admin', '/admin/*'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin/index.html'));
});

// Fallback route for SPA or root
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error occurred.'
  });
});

// Start Server
const PORT = config.port;
app.listen(PORT, () => {
  console.log(`================================================================`);
  console.log(`🎓 CONVOCATION ASSISTANT AI AGENT SERVER STARTED`);
  console.log(`📡 URL: http://localhost:${PORT}`);
  console.log(`💬 Student Chat: http://localhost:${PORT}/`);
  console.log(`🔐 Admin Portal: http://localhost:${PORT}/admin`);
  console.log(`⚙️  Environment: ${config.nodeEnv}`);
  console.log(`🗄️  Database: ${firebaseService.isConnectedToFirestore() ? 'Live Google Cloud Firestore' : 'Structured Local Store'}`);
  console.log(`🤖 AI Engine: Google Gemini (${config.gemini.model}) - ${config.gemini.isConfigured ? 'Active' : 'Fallback Engine Ready'}`);
  console.log(`================================================================`);
});

module.exports = app;
