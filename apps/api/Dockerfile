# Usa una imagen oficial de Node.js
FROM node:18-alpine

# Establece el directorio de trabajo dentro del contenedor
WORKDIR /usr/src/app

# Copia package.json y package-lock.json primero (para aprovechar cache de Docker)
COPY package*.json ./

# Instala dependencias
RUN npm install

# Copia el resto del código
COPY . .

# Expone el puerto en el que corre tu app (ej. 3000)
EXPOSE 3000

RUN npm run build

# Define el comando de inicio
CMD ["npm", "run", "start"]
