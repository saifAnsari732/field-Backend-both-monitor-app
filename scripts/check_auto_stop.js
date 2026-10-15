const mongoose = require('mongoose');
require('dotenv').config({ path: 'h:/C_Desktop_Backup/field-App/CRM-B/.env' });

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const collections = await mongoose.connection.db.listCollections().toArray();
  for (const c of collections) {
    const coll = mongoose.connection.db.collection(c.name);
    try {
      const docs = await coll.find({
        $or: [
          { desc: { $regex: 'auto-stop', $options: 'i' } },
          { description: { $regex: 'auto-stop', $options: 'i' } },
          { reason: { $regex: 'auto-stop', $options: 'i' } },
          { action: { $regex: 'auto-stop', $options: 'i' } },
          { remarks: { $regex: 'auto-stop', $options: 'i' } },
          { note: { $regex: 'auto-stop', $options: 'i' } }
        ]
      }).sort({ _id: -1 }).limit(3).toArray();

      if (docs.length > 0) {
        console.log('Found in collection:', c.name, 'count:', docs.length);
        console.log('Sample doc:', JSON.stringify(docs[0], null, 2));
      }
    } catch (e) {
      // skip collection if schema doesn't support query
    }
  }
  await mongoose.disconnect();
}
check();
