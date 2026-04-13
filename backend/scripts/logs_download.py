#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Device log downloader — downloads logs from S3 for a given device and date,
unzips them, and unifies them into single per-service files with resolved
epoch timestamps.

Usage: python logs_download.py <device_id> <date (yyyy-mm-dd)>
"""
import sys
import os
from datetime import datetime

# Ensure a full PATH so os.system() calls (7z, aws, find, sort, rm) work
# even when launched from a systemd service with a stripped environment.
os.environ["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin:" + os.environ.get("PATH", "")


def isInt(value):
    try:
        int(value)
        return True
    except ValueError:
        return False


if len(sys.argv[1:]) < 1:
    device_id = str(input('Enter device id: '))
    if len(device_id) == 0:
        print('\n\n******* Please enter device id or follow Usage: python logs_download.py <device_id> <date> *******\n\n')
        sys.exit()
else:
    device_id = sys.argv[1]

if len(device_id) == 1:
    device_id = '1630000' + device_id
elif len(device_id) == 2:
    device_id = '163000' + device_id
elif len(device_id) == 3:
    device_id = '16300' + device_id
elif len(device_id) == 4:
    device_id = '1630' + device_id
elif len(device_id) == 5:
    device_id = '163' + device_id

log_date = ''
if len(sys.argv[1:]) < 2:
    log_date = str(input('Enter date for download: '))
else:
    log_date = sys.argv[2]

today_date = str(datetime.today().strftime('%Y-%m-%d'))
if len(log_date) == 0:
    log_date = today_date
elif len(log_date) == 1:
    log_date = today_date[:-2] + '0' + log_date
elif len(log_date) == 2:
    log_date = today_date[:-2] + log_date
elif len(log_date) == 4:
    log_date = today_date[:-5] + '0' + log_date
elif len(log_date) == 5:
    log_date = today_date[:-5] + log_date

print('Downloading logs of device ' + device_id + ' for ' + log_date)

if not os.path.exists(device_id):
    os.makedirs(device_id)

download_cmd = 'aws s3 sync --profile s3view s3://idms-staging/logs_0/' + device_id + '/' + log_date + ' ' + device_id + '/' + log_date + '/'
os.system(download_cmd)
download_cmd = 'aws s3 sync --profile s3view s3://idms-staging/logs_1/' + device_id + '/' + log_date + ' ' + device_id + '/' + log_date + '/'
os.system(download_cmd)
download_cmd = 'aws s3 sync --profile s3view s3://idms-staging/logs_2/' + device_id + '/' + log_date + ' ' + device_id + '/' + log_date + '/'
os.system(download_cmd)
download_cmd = 'aws s3 sync --profile s3view s3://idms-staging/logs_3/' + device_id + '/' + log_date + ' ' + device_id + '/' + log_date + '/'
os.system(download_cmd)
download_cmd = 'aws s3 sync --profile s3view s3://idms-staging/logs_4/' + device_id + '/' + log_date + ' ' + device_id + '/' + log_date + '/'
os.system(download_cmd)

base_path = device_id + '/' + log_date + '/'
if not os.path.exists(base_path):
    print('No logs exist for given date')
    sys.exit()

print('Unzipping files')
for filename in os.listdir(base_path):
    if '.zip' in filename:
        unzip_cmd = '7z x ' + base_path + filename + ' -o./' + base_path + filename[:-4] + '/ -y'
        os.system(unzip_cmd)
    elif '.7z' in filename:
        unzip_cmd = '7z x ' + base_path + filename + ' -o./' + base_path + filename[:-3] + '/ -y'
        os.system(unzip_cmd)

print('unifying log')

if not os.path.exists(base_path + 'output'):
    os.makedirs(base_path + 'output')

os.system('rm -rf ' + base_path + 'output/*')

unify_cmd = 'find ./' + base_path + ' -type f \\( -iname "*.log*" ! -iname "*.zip" ! -iname "*.7z" ! -iname "*.txt" \\) | ' \
            'sort -t \'/\' -k6,2 -k4,1 | while read -r a; do cat $a >> "./' + base_path + \
            'output/"$(echo $a | cut -d \'/\' -f5)".txt"; done'

os.system(unify_cmd)

print('logs unified. now append timestamp')

unified_logs_folder = base_path + 'output/'
for filename in os.listdir(unified_logs_folder):
    try:
        if 'log' in filename:
            continue
        out_filename = unified_logs_folder + filename + '_out'
        print('Correcting timestamps for file ' + filename)
        fr = open(unified_logs_folder + filename)
        fw = open(out_filename, 'w+')
        line = fr.readline()
        service_start_time = 0
        while line:
            epoch_time = ""
            try:
                if 'service start epoch time: ' in line:
                    service_start_time = ''.join(x for x in line if x.isdigit())
                if ': I :' in line or ': E :' in line or ': C :' in line or ': D :' in line or ': W :' in line:
                    if isInt(line.split(':')[0]):
                        epoch_time = int(line.split(':')[0])
                        if epoch_time < 1420070400000 and service_start_time != "":
                            epoch_time = epoch_time + int(service_start_time)
                        gmt_time = datetime.utcfromtimestamp(int(epoch_time / 1000)).strftime('%Y-%m-%d %H:%M:%S')
                        line = line.replace(line.split(':')[0], gmt_time + ": " + str(epoch_time) + ": " + str(int(line.split(':')[0])))
                fw.write(line)
            except Exception as e1:
                print("exception : " + str(e1))
                try:
                    print(str(int(line.split(':')[0]) + int(service_start_time)))
                except Exception:
                    pass
            line = fr.readline()
        os.system('rm ' + unified_logs_folder + filename)
    except Exception as e:
        print("some exception : " + str(e))
        pass
    fr.close()
    fw.close()

print("Done")
