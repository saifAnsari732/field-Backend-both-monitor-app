const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const ImageKit = require('imagekit');

const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY || '',
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY || '',
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT || '',
});

// Get ImageKit auth params (for client-side upload)
router.get('/auth', protect, (req, res) => {
  try {
    const result = imagekit.getAuthenticationParameters();
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Server-side upload
router.post('/image', protect, async (req, res) => {
  try {
    const { file, fileName, folder = '/crm-tracker' } = req.body;
    const response = await imagekit.upload({ file, fileName, folder, useUniqueFileName: true });
    res.json({ success: true, url: response.url, fileId: response.fileId, thumbnailUrl: response.thumbnailUrl });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
