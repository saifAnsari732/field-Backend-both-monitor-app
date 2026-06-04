const mongoose = require('mongoose');

const newsSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: true
  },
  content: {
    type: String, // इसमें रिच टेक्स्ट एडिटर का HTML कंटेंट सेव होगा
    required: true
  },
  category: {
    type: String,
    required: true,
    default: 'अन्य'
  },
  image: {
    type: String,
    default: 'https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=800&q=80'
  },
  videoUrl: {
    type: String,
    default: ''
  },
  author: {
    type: String,
    default: 'संपादक'
  },
  date: {
    type: String, // उदा. "2 जून 2026"
    required: true
  },
  published: {
    type: Boolean,
    default: false // फॉर्म भरने पर पहले false (Draft) सेव होगा
  },
  trending: {
    type: Boolean,
    default: true
  },
  breaking: {
    type: Boolean,
    default: true
  },
  location: {
    type: String,
    default: ''
  },
  tags: {
    type: [String],
    default: []
  },
  keywords: {
    type: String,
    default: ''
  },
  link: {
    type: String,
    default: 'https://saif-me.com'
  }
}, {
  timestamps: true // createAt, updatedAt आटोमेटिक जोड़ेगा
});

module.exports = mongoose.model('News', newsSchema);