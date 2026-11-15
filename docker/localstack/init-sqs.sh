#!/bin/bash
# Roda dentro do LocalStack quando ele fica "ready". Cria as 3 filas FIFO.
set -euo pipefail

DLQ_URL=$(awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true --query QueueUrl --output text)

DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

# Quem manda para a DLQ é o app: na 5ª falha de bug, ou depois de 30 min de erro transitório (wager-consumer.ts).
# A redrive (100) é rede de segurança, acima do que esses limites consomem: devolver mensagens sem processar
# (shutdown, wallet bloqueada no lote) também conta recebimento.
awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes "{
  \"FifoQueue\": \"true\",
  \"VisibilityTimeout\": \"30\",
  \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"100\\\"}\"
}"

# Destino dos eventos publicados pela outbox. Criada por último: o healthcheck usa ela.
awslocal sqs create-queue --queue-name wallet-events.fifo --attributes FifoQueue=true
