const express = require('express');
const router = express.Router();
const News = require('../models/newsModle'); // अपने पाथ के अनुसार बदलें
const ImageKit = require('imagekit');

// ImageKit initialization
const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY ,
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY, 
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT 
});

// A. ImageKit Authentication Parameters (फाइल अपलोड करने के लिए सिग्नेचर)
router.get('/auth/imagekit', (req, res) => {
  try {
    const authenticationParameters = imagekit.getAuthenticationParameters();
    res.status(200).json(authenticationParameters);
  } catch (err) {
    res.status(500).json({ error: "Failed to generate authentication parameters", details: err.message });
  }
});

// B. GET ALL PUBLISHED NEWS (वेबसाइट पर लाइव खबरें दिखाने के लिए)
router.get('/news', async (req, res) => {
  try {
    // केवल वही खबरें भेजें जो पब्लिश हैं
    const articles = await News.find({ published: true }).sort({ createdAt: -1 });
    res.status(200).json(articles);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch news", details: err.message });
  }
});

// C. SAVE NEWS AS DRAFT (फॉर्म सबमिट करने पर पहले डेटाबेस में ड्राफ्ट सेव होगा)
router.post('/news', async (req, res) => {
  try {
    const { title, description, content, category, image, videoUrl, author, date } = req.body;

    const newArticle = new News({
      title,
      description,
      content,
      category,
      image,
      videoUrl,
      author,
      date,
      published: false // पब्लिश बटन दबाने से पहले ड्राफ्ट रहेगा
    });

    const savedArticle = await newArticle.save();
    res.status(201).json({
      message: "News saved successfully to DB as draft!",
      article: savedArticle
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to save news draft", details: err.message });
  }
});

// D. PUBLISH NEWS BY ID (ड्राफ्ट को लाइव/पब्लिश करने के लिए)
router.put('/news/:id/publish', async (req, res) => {
  try {
    const { id } = req.params;

    const updatedArticle = await News.findByIdAndUpdate(
      id,
      { published: true },
      { new: true } // अपडेटेड डॉक्यूमेंट वापस पाने के लिए
    );

    if (!updatedArticle) {
      return res.status(404).json({ error: "Article not found" });
    }

    res.status(200).json({
      message: "Article published live successfully!",
      article: updatedArticle
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to publish news", details: err.message });
  }
});

// B2. GET ALL UNPUBLISHED NEWS (डेटाबेस से सभी अप्रकाशित/ड्राफ्ट खबरें प्राप्त करने के लिए)
router.get('/news/drafts', async (req, res) => {
  try {
    // केवल वही खबरें भेजें जो पब्लिश नहीं हैं (Drafts)
    const drafts = await News.find({ published: false }).sort({ createdAt: -1 });
    res.status(200).json(drafts);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch draft news", details: err.message });
  }
});

// D. PUBLISH NEWS BY ID (ड्राफ्ट को लाइव/पब्लिश करने के लिए)
router.put('/news/:id/publish', async (req, res) => {
  try {
    const { id } = req.params;

    const updatedArticle = await News.findByIdAndUpdate(
      id,
      { published: true },
      { new: true } // अपडेटेड डॉक्यूमेंट वापस पाने के लिए
    );

    if (!updatedArticle) {
      return res.status(404).json({ error: "Article not found" });
    }

    res.status(200).json({
      message: "Article published live successfully!",
      article: updatedArticle
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to publish news", details: err.message });
  }
});

module.exports = router;