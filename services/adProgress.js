const express = require('express');
const EventEmitter = require('events');

// Progress Tracker Class
class ProgressTracker extends EventEmitter {
    constructor() {
        super();
        this.jobs = new Map();
    }

    startJob(jobId, totalSteps, description = 'Starting ad creation...') {
        const jobData = {
            jobId, totalSteps, currentStep: 0, progress: 0,
            message: description, status: 'processing', startTime: Date.now(), steps: []
        };
        this.jobs.set(jobId, jobData);
        this.emitProgress(jobId);
        return jobData;
    }

    setProgress(jobId, progress, message, stepDetails = null) {
        const job = this.jobs.get(jobId);
        if (!job) return;

        job.progress = Math.min(Math.max(progress, 0), 100);
        job.message = message;
        this.jobs.set(jobId, job);
        this.emitProgress(jobId);
    }

    emitProgress(jobId) {
        const job = this.jobs.get(jobId);
        if (job) {
            this.emit(`progress-${jobId}`, {
                progress: job.progress, message: job.message, status: job.status, timestamp: Date.now()
            });
        }
    }

    completeJob(jobId, message = 'Ad creation completed successfully!') {
        const job = this.jobs.get(jobId);
        if (!job) return;
        job.progress = 100; job.message = message; job.status = 'complete';
        this.jobs.set(jobId, job);
        this.emitProgress(jobId);
        setTimeout(() => this.jobs.delete(jobId), 300000);
    }

    errorJob(jobId, error) {
        const job = this.jobs.get(jobId);
        if (!job) return;
        job.status = 'error'; job.message = error;
        this.jobs.set(jobId, job);
        this.emitProgress(jobId);
    }

    getProgress(jobId) {
        const job = this.jobs.get(jobId);
        return job ? { progress: job.progress, message: job.message, status: job.status }
            : { progress: 0, message: 'Job not found', status: 'error' };
    }

    onUpdate(jobId, callback) {
        const eventName = `progress-${jobId}`;
        this.on(eventName, callback);
        return () => this.removeListener(eventName, callback);
    }
}

// Utilities
function generateJobId() {
    return Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9);
}

function getProgressMessage(step, context = {}) {
    const messages = {
        validation: 'Validating request data...',
        s3_video_processing: `Processing S3 video: ${context.fileName}...`,
        video_upload: `Uploading video: ${context.fileName}...`,
        image_upload: `Uploading image: ${context.fileName}...`,
        ad_creation: `Creating ad: ${context.adName}...`,
        success: 'All ads created successfully!'
    };
    return messages[step] || 'Processing...';
}

// Singleton instance
let progressTracker = null;
function getProgressTracker() {
    if (!progressTracker) {
        progressTracker = new ProgressTracker();
    }
    return progressTracker;
}

// Routes
const router = express.Router();

router.get('/progress/:jobId', (req, res) => {
    const { jobId } = req.params;
    console.log(`🔍 SSE connection attempt for ${jobId} at:`, new Date().toISOString());
    console.log('📋 Available jobs:', Array.from(progressTracker.jobs.keys()));

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });

    const tracker = getProgressTracker();
    const currentProgress = tracker.getProgress(jobId);
    res.write(`data: ${JSON.stringify(currentProgress)}\n\n`);

    const cleanup = tracker.onUpdate(jobId, (progress) => {
        res.write(`data: ${JSON.stringify(progress)}\n\n`);
        if (progress.status === 'complete' || progress.status === 'error') {
            setTimeout(() => { cleanup(); res.end(); }, 1000);
        }
    });

    req.on('close', cleanup);
    req.on('aborted', cleanup);
});

module.exports = { getProgressTracker, generateJobId, getProgressMessage, router };