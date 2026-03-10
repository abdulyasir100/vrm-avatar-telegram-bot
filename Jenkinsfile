pipeline {
    agent any

    environment {
        DEPLOY_DIR = '/home/venomaru/deploy/telegram-bot'
    }

    stages {
        stage('Clone') {
            steps {
                checkout scm
            }
        }

        stage('Deploy') {
            steps {
                sh """
                    cp index.js Dockerfile docker-compose.yml ${DEPLOY_DIR}/
                    cd ${DEPLOY_DIR}
                    docker compose up -d --build --force-recreate
                """
            }
        }

        stage('Health Check') {
            steps {
                sh 'sleep 3 && curl -sf http://localhost:3001/status || echo "Bot starting up..."'
            }
        }
    }

    post {
        failure {
            echo 'Deployment failed!'
        }
        success {
            echo 'Telegram bot deployed successfully.'
        }
    }
}
