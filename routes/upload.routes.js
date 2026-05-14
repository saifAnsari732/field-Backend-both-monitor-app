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

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

// Server-side upload using multer
router.post('/image', protect, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    
    const response = await imagekit.upload({
      file: req.file.buffer,
      fileName: req.file.originalname,
      folder: '/crm-tracker',
      useUniqueFileName: true
    });

    res.json({ success: true, url: response.url, fileId: response.fileId, thumbnailUrl: response.thumbnailUrl });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
