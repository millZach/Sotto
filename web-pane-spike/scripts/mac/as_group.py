"""Run as root (through sudo): drops to <user> with <group> as the effective and real group, keeping the user's other
groups, then runs the command. The process keeps the user's GUI session; pf rules that name the group match only its
sockets. Usage: sudo python3 -I as_group.py <user> <group> <command> [args...]"""
import grp, os, pwd, sys
user, group, cmd = sys.argv[1], sys.argv[2], sys.argv[3:]
pw = pwd.getpwnam(user)
gid = grp.getgrnam(group).gr_gid
os.setgroups(sorted(set(os.getgrouplist(user, pw.pw_gid)) | {gid}))
os.setgid(gid)
os.setuid(pw.pw_uid)
os.execv(cmd[0], cmd)
