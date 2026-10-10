require('dotenv').config();
const mongoose = require('mongoose');
const { LiveLocation, User } = require('./models');

const mongoUri = process.env.MONGODB_URI || 'mongodb+srv://ansarisaifuddin732_db_user:M2oWIFAFysw7DpGi@cluster0.gbipgw2.mongodb.net/';

async function liveCheck() {
  await mongoose.connect(mongoUri);
  const user = await User.findOne({ name: { $regex: 'saifuddin', $options: 'i' } });
  const activeLoc = await LiveLocation.findOne({ employee: user._id, isActive: true }).sort({ createdAt: -1 });

  const coords = activeLoc.coordinates || [];
  const latest = coords[coords.length - 1];

  console.log('Total coords in DB:', coords.length);
  console.log('Latest coord timestamp:', latest ? latest.timestamp : 'None');
  console.log('Current time (UTC):', new Date().toISOString());
  console.log('Difference in seconds:', latest ? (Date.now() - new Date(latest.timestamp).getTime()) / 1000 : 'N/A');
  console.log('Latest coord details:', JSON.stringify(latest, null, 2));

  process.exit(0);
}

liveCheck();
