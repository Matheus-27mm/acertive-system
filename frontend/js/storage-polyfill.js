// Polyfill para localStorage no Node.js
const fs = require('fs');
const path = require('path');

class NodeStorage {
    constructor(filename = 'storage-data.json') {
        this.filename = path.join(__dirname, filename);
        this.data = this.load();
    }
    
    load() {
        try {
            if (fs.existsSync(this.filename)) {
                const data = fs.readFileSync(this.filename, 'utf8');
                return JSON.parse(data);
            }
        } catch (error) {
            console.error('Erro ao carregar storage:', error.message);
        }
        return {};
    }
    
    save() {
        try {
            fs.writeFileSync(this.filename, JSON.stringify(this.data, null, 2));
        } catch (error) {
            console.error('Erro ao salvar storage:', error.message);
        }
    }
    
    getItem(key) {
        return this.data[key] || null;
    }
    
    setItem(key, value) {
        this.data[key] = value;
        this.save();
    }
    
    removeItem(key) {
        delete this.data[key];
        this.save();
    }
    
    clear() {
        this.data = {};
        this.save();
    }
}

// Criar instância global
global.localStorage = new NodeStorage();

module.exports = NodeStorage;